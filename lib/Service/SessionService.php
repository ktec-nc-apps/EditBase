<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCP\ICacheFactory;
use OCP\IUserManager;

/**
 * Who else has this document open.
 *
 * Two people writing in one document need to know about each other before they
 * need anything else, and they need it without a server of its own: this is kept
 * in Nextcloud's own cache, one small record per document, written by the same
 * poll that asks whether the file has changed. Nothing is stored on disk, and a
 * record that stops being touched disappears by itself.
 */
class SessionService {
	private const GONE = 25;

	public function __construct(
		private ICacheFactory $cacheFactory,
		private IUserManager $users,
	) {
	}

	/**
	 * Say that this person is still here, and hand back everyone who is.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function beat(int $fileId, string $userId, bool $writing): array {
		$cache = $this->cacheFactory->createDistributed('editbase-open');
		$key = 'doc-' . $fileId;
		$now = time();
		$here = $cache->get($key);
		$here = is_array($here) ? $here : [];
		$here[$userId] = ['at' => $now, 'writing' => $writing];
		// Anyone who has not said anything for a while has closed the page or lost
		// the network; either way they are not here.
		foreach ($here as $uid => $seen) {
			if (!is_array($seen) || ($now - (int)($seen['at'] ?? 0)) > self::GONE) {
				unset($here[$uid]);
			}
		}
		$cache->set($key, $here, 120);
		$out = [];
		foreach ($here as $uid => $seen) {
			$user = $this->users->get((string)$uid);
			$out[] = [
				'id' => (string)$uid,
				'name' => $user === null ? (string)$uid : $user->getDisplayName(),
				'writing' => (bool)($seen['writing'] ?? false),
				'me' => (string)$uid === $userId,
			];
		}
		usort($out, static fn ($a, $b) => strcasecmp($a['name'], $b['name']));
		return $out;
	}

	/** Say that this person has closed it. */
	public function leave(int $fileId, string $userId): void {
		$cache = $this->cacheFactory->createDistributed('editbase-open');
		$key = 'doc-' . $fileId;
		$here = $cache->get($key);
		if (!is_array($here) || !isset($here[$userId])) {
			return;
		}
		unset($here[$userId]);
		$cache->set($key, $here, 120);
	}
}
