<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCP\Constants;
use OCP\Files\File;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IUserManager;
use OCP\Share\IManager;
use OCP\Share\IShare;

/**
 * Sharing a document with someone else on this server.
 *
 * A document is a file, so this is Nextcloud's own sharing and nothing else: the
 * share made here is the share the Files app shows, it can be taken back from
 * either place, and a document shared with you arrives in your own Files where
 * the rest of the app already knows how to open it. Only accounts on this server
 * — no links, no e-mail, nothing that leaves.
 */
class ShareService {
	public function __construct(
		private IManager $shares,
		private IRootFolder $rootFolder,
		private IUserManager $users,
	) {
	}

	/** The file, resolved inside the asking user's own storage. */
	private function node(string $userId, int $id): File {
		foreach ($this->rootFolder->getUserFolder($userId)->getById($id) as $node) {
			if ($node instanceof File) {
				return $node;
			}
		}
		throw new NotFoundException('document ' . $id . ' not found');
	}

	/**
	 * Who this document is shared with, and whether each of them may write in it.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function listShares(string $userId, int $id): array {
		$node = $this->node($userId, $id);
		$out = [];
		foreach ([IShare::TYPE_USER, IShare::TYPE_GROUP] as $type) {
			foreach ($this->shares->getSharesBy($userId, $type, $node, false, 50) as $share) {
				$with = $share->getSharedWith();
				$out[] = [
					'id' => $share->getFullId(),
					'with' => $with,
					'name' => $this->displayName($with, $type),
					'group' => $type === IShare::TYPE_GROUP,
					'canEdit' => ($share->getPermissions() & Constants::PERMISSION_UPDATE) !== 0,
				];
			}
		}
		return $out;
	}

	/** Share it with one account on this server, to read or to write in. */
	public function share(string $userId, int $id, string $with, bool $canEdit): array {
		$with = trim($with);
		if ($with === '' || $with === $userId) {
			throw new \InvalidArgumentException('nobody to share with');
		}
		if (!$this->users->userExists($with)) {
			throw new \InvalidArgumentException('no such account: ' . $with);
		}
		$node = $this->node($userId, $id);
		if (!$node->isShareable()) {
			throw new NotPermittedException('this document may not be shared on');
		}
		// Already shared with them: change what they may do rather than making a second one.
		foreach ($this->shares->getSharesBy($userId, IShare::TYPE_USER, $node, false, 50) as $existing) {
			if ($existing->getSharedWith() === $with) {
				$existing->setPermissions($this->permissions($canEdit));
				$this->shares->updateShare($existing);
				return $this->listShares($userId, $id);
			}
		}
		$share = $this->shares->newShare();
		$share->setNode($node);
		$share->setShareType(IShare::TYPE_USER);
		$share->setSharedWith($with);
		$share->setSharedBy($userId);
		$share->setPermissions($this->permissions($canEdit));
		$this->shares->createShare($share);
		return $this->listShares($userId, $id);
	}

	/** Take a share back. Only the person who made it may. */
	public function unshare(string $userId, int $id, string $shareId): array {
		$share = $this->shares->getShareById($shareId);
		if ($share->getSharedBy() !== $userId && $share->getShareOwner() !== $userId) {
			throw new NotPermittedException('that share is not yours to undo');
		}
		$this->shares->deleteShare($share);
		return $this->listShares($userId, $id);
	}

	/**
	 * Accounts on this server whose name or id begins like this, for the picker.
	 * Never the asker themselves, and never more than a screenful.
	 *
	 * @return array<int, array<string, string>>
	 */
	public function findUsers(string $userId, string $term): array {
		$term = trim($term);
		$out = [];
		$seen = [];
		foreach ($this->users->search($term, 25) as $user) {
			$uid = $user->getUID();
			if ($uid === $userId || isset($seen[$uid]) || !$user->isEnabled()) {
				continue;
			}
			$seen[$uid] = true;
			$out[] = ['id' => $uid, 'name' => $user->getDisplayName()];
		}
		foreach ($this->users->searchDisplayName($term, 25) as $user) {
			$uid = $user->getUID();
			if ($uid === $userId || isset($seen[$uid]) || !$user->isEnabled()) {
				continue;
			}
			$seen[$uid] = true;
			$out[] = ['id' => $uid, 'name' => $user->getDisplayName()];
		}
		usort($out, static fn ($a, $b) => strcasecmp($a['name'], $b['name']));
		return array_slice($out, 0, 25);
	}

	private function permissions(bool $canEdit): int {
		return $canEdit
			? Constants::PERMISSION_READ | Constants::PERMISSION_UPDATE | Constants::PERMISSION_SHARE
			: Constants::PERMISSION_READ;
	}

	private function displayName(string $with, int $type): string {
		if ($type === IShare::TYPE_GROUP) {
			return $with;
		}
		$user = $this->users->get($with);
		return $user === null ? $with : $user->getDisplayName();
	}
}
