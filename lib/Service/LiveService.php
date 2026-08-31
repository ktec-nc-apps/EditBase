<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCP\ICacheFactory;
use OCP\IUserManager;

/**
 * The fast lane between two people writing in one document.
 *
 * Saving is how a document is kept; this is how it is *seen*. What has just been
 * typed goes here the moment it is typed -- a handful of paragraphs, held in
 * Nextcloud's own cache for a couple of minutes and never written to disk -- so
 * the other person's screen can show it about a second later, without the file
 * being written on every keystroke.
 *
 * One record per document: a running number, the last few parcels of paragraphs,
 * and who is here with where their caret is. Everything in it expires by itself,
 * so nothing has to be tidied up when a page is closed or a network drops.
 */
class LiveService {
	private const KEEP = 40;
	private const GONE = 12;
	private const TTL = 180;
	private const MAX_BLOCK = 40000;

	public function __construct(
		private ICacheFactory $cacheFactory,
		private IUserManager $users,
	) {
	}

	/**
	 * Put what this person has just typed in, and take everything the others have
	 * typed since they last asked. One turn of the conversation, one request.
	 *
	 * @param array<int, array<string, mixed>> $blocks
	 * @return array<string, mixed>
	 */
	public function exchange(int $fileId, string $userId, int $since, array $blocks, array $where): array {
		$cache = $this->cacheFactory->createDistributed('editbase-live');
		$key = 'doc-' . $fileId;
		$now = time();
		$rec = $cache->get($key);
		$rec = is_array($rec) ? $rec : ['seq' => 0, 'items' => [], 'people' => []];
		$seq = (int)($rec['seq'] ?? 0);
		$items = is_array($rec['items'] ?? null) ? $rec['items'] : [];
		$people = is_array($rec['people'] ?? null) ? $rec['people'] : [];

		// What this person has just written.
		$clean = [];
		foreach ($blocks as $block) {
			if (!is_array($block)) {
				continue;
			}
			$id = (string)($block['id'] ?? '');
			$html = (string)($block['html'] ?? '');
			if ($id === '' || strlen($html) > self::MAX_BLOCK) {
				continue;
			}
			$clean[] = ['id' => $id, 'html' => $html, 'gone' => !empty($block['gone']), 'after' => (string)($block['after'] ?? '')];
		}
		if ($clean !== []) {
			$seq += 1;
			$items[] = ['seq' => $seq, 'uid' => $userId, 'at' => $now, 'blocks' => $clean];
			if (count($items) > self::KEEP) {
				$items = array_slice($items, -self::KEEP);
			}
		}

		// Where this person is, and who else is here. When they last actually wrote
		// something is kept as well: a caret parked in a paragraph while somebody
		// reads their mail must not hold that paragraph against everyone else.
		$wrote = (int)($people[$userId]['wrote'] ?? 0);
		if ($clean !== [] || !empty($where['writing'])) {
			$wrote = $now;
		}
		$people[$userId] = [
			'at' => $now,
			'wrote' => $wrote,
			'block' => (string)($where['block'] ?? ''),
			'caret' => (int)($where['caret'] ?? 0),
			'writing' => !empty($where['writing']),
		];
		foreach ($people as $uid => $seen) {
			if (!is_array($seen) || ($now - (int)($seen['at'] ?? 0)) > self::GONE) {
				unset($people[$uid]);
			}
		}

		$cache->set($key, ['seq' => $seq, 'items' => $items, 'people' => $people], self::TTL);

		// Everything somebody else has written since this person last asked.
		$out = [];
		foreach ($items as $item) {
			if ((int)($item['seq'] ?? 0) <= $since || (string)($item['uid'] ?? '') === $userId) {
				continue;
			}
			$out[] = ['seq' => (int)$item['seq'], 'uid' => (string)$item['uid'], 'blocks' => $item['blocks']];
		}
		return [
			'seq' => $seq,
			// A newcomer must not be handed the whole buffer as if it were news:
			// they have just read the file, which already holds all of it.
			'items' => $since <= 0 ? [] : $out,
			'people' => $this->describePeople($people, $userId),
		];
	}

	/** Say that this person has gone. */
	public function leave(int $fileId, string $userId): void {
		$cache = $this->cacheFactory->createDistributed('editbase-live');
		$key = 'doc-' . $fileId;
		$rec = $cache->get($key);
		if (!is_array($rec) || !isset($rec['people'][$userId])) {
			return;
		}
		unset($rec['people'][$userId]);
		$cache->set($key, $rec, self::TTL);
	}

	/** @return array<int, array<string, mixed>> */
	private function describePeople(array $people, string $userId): array {
		$out = [];
		foreach ($people as $uid => $seen) {
			$user = $this->users->get((string)$uid);
			$out[] = [
				'id' => (string)$uid,
				'name' => $user === null ? (string)$uid : $user->getDisplayName(),
				'block' => (string)($seen['block'] ?? ''),
				'caret' => (int)($seen['caret'] ?? 0),
				'writing' => !empty($seen['writing']),
				// Writing here in the last twenty seconds: their paragraph is theirs.
				'active' => (time() - (int)($seen['wrote'] ?? 0)) < 20,
				'me' => (string)$uid === $userId,
			];
		}
		usort($out, static fn ($a, $b) => strcasecmp((string)$a['name'], (string)$b['name']));
		return $out;
	}
}
