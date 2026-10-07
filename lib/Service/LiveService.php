<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCP\ICache;
use OCP\ICacheFactory;
use OCP\IMemcache;
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
 *
 * The record is read, added to and written back one turn at a time (review S9):
 * two people sending in the same instant used to both read it before either
 * wrote, and one of them was lost -- with both handed the same running number,
 * so neither was shown the other's paragraphs.
 */
class LiveService {
	private const KEEP = 40;
	private const GONE = 12;
	private const TTL = 180;
	private const MAX_BLOCK = 40000;

	/** How long a turn waits for the one before it, in seconds. */
	private float $wait = 2.0;

	public function __construct(
		private ICacheFactory $cacheFactory,
		private IUserManager $users,
	) {
	}

	/**
	 * Put what this person has just typed in, and take everything the others have
	 * typed since they last asked. One turn of the conversation, one request.
	 *
	 * Somebody who may only read the document ($mayWrite false) is shown what the
	 * others write, and where they are, but nothing they send is passed on (review
	 * S2) -- nor are they counted as writing, which would hold a paragraph against
	 * the people who may.
	 *
	 * @param array<int, array<string, mixed>> $blocks
	 * @return array<string, mixed>
	 */
	public function exchange(int $fileId, string $userId, int $since, array $blocks, array $where, bool $mayWrite = true): array {
		if (!$mayWrite) {
			$blocks = [];
			$where['writing'] = false;
		}
		$cache = $this->cacheFactory->createDistributed('editbase-live');
		$key = 'doc-' . $fileId;
		$held = $this->hold($cache, $key);
		try {
			return $this->turn($cache, $key, $userId, $since, $blocks, $where);
		} finally {
			$this->release($cache, $key, $held);
		}
	}

	/**
	 * @param array<int, array<string, mixed>> $blocks
	 * @return array<string, mixed>
	 */
	private function turn(ICache $cache, string $key, string $userId, int $since, array $blocks, array $where): array {
		$now = time();
		$rec = $cache->get($key);
		$rec = is_array($rec) ? $rec : ['seq' => 0, 'items' => [], 'people' => []];
		$seq = (int)($rec['seq'] ?? 0);
		if ($seq <= 0) {
			// The running number never starts at nought: a page that joined before
			// anyone had written keeps nought as "the last one I saw", and nought is
			// also what a newcomer says -- so the first thing written after it used
			// to be withheld from it as old news (review S9). Counting from the clock
			// also keeps a record that has lapsed and been begun again ahead of any
			// number a page still holds from the one before.
			$seq = (int)floor(microtime(true) * 1000);
		}
		$items = is_array($rec['items'] ?? null) ? $rec['items'] : [];
		$people = is_array($rec['people'] ?? null) ? $rec['people'] : [];

		// What this person has just written. A paragraph's name is the short word
		// nameBlocks() in the editor gives it, and nothing else is passed on as one
		// (review 2026-10-04, 低6): the other screens put the name into a selector.
		$clean = [];
		foreach ($blocks as $block) {
			if (!is_array($block)) {
				continue;
			}
			$id = self::blockName($block['id'] ?? '');
			$html = (string)($block['html'] ?? '');
			if ($id === '' || strlen($html) > self::MAX_BLOCK) {
				continue;
			}
			$clean[] = ['id' => $id, 'html' => $html, 'gone' => !empty($block['gone']), 'after' => self::blockName($block['after'] ?? '')];
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
			'block' => self::blockName($where['block'] ?? ''),
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

	/** A paragraph's name as the editor writes it (letters, digits, - and _), or nothing. */
	public static function blockName(mixed $id): string {
		return is_string($id) && preg_match('/^[\w-]{1,64}$/', $id) ? $id : '';
	}

	/** Say that this person has gone. */
	public function leave(int $fileId, string $userId): void {
		$cache = $this->cacheFactory->createDistributed('editbase-live');
		$key = 'doc-' . $fileId;
		$held = $this->hold($cache, $key);
		try {
			$rec = $cache->get($key);
			if (!is_array($rec) || !isset($rec['people'][$userId])) {
				return;
			}
			unset($rec['people'][$userId]);
			$cache->set($key, $rec, self::TTL);
		} finally {
			$this->release($cache, $key, $held);
		}
	}

	/**
	 * Wait for the record to be free, and take it. The hold lapses by itself after
	 * a few seconds, so a request that dies holding it does not stop the document.
	 * A cache that cannot do this (none is configured) is used as it is.
	 */
	private function hold(ICache $cache, string $key): bool {
		if (!($cache instanceof IMemcache)) {
			return false;
		}
		$until = microtime(true) + $this->wait;
		while (!$cache->add($key . ':turn', 1, 5)) {
			if (microtime(true) >= $until) {
				// The page sends the same paragraphs again on its next turn.
				throw new \RuntimeException('the document is busy; it will be tried again');
			}
			usleep(10000);
		}
		return true;
	}

	private function release(ICache $cache, string $key, bool $held): void {
		if ($held) {
			$cache->remove($key . ':turn');
		}
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
