<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCP\Files\Node;
use OCP\Files\Storage\ISharedStorage;

/**
 * Whether a file may be taken away from where it was shared.
 *
 * A share can say "hide download": the person it is shared with may read it,
 * but not keep a copy of it. Nextcloud holds its own download and copy routes to
 * that; an app reading files through the files API has to hold itself to it
 * (review S3). EditBase still opens such a document to be read and written in,
 * but does not copy it into the reader's own folder, move it out of the share,
 * or put its pictures and notes into another document.
 */
final class Downloads {
	public static function allowed(Node $node): bool {
		try {
			$storage = $node->getStorage();
			if (!$storage->instanceOfStorage(ISharedStorage::class)) {
				return true;
			}
		} catch (\Throwable) {
			return true;
		}
		try {
			/** @var ISharedStorage $storage */
			$attributes = $storage->getShare()->getAttributes();
			return $attributes === null || $attributes->getAttribute('permissions', 'download') !== false;
		} catch (\Throwable) {
			// A shared file whose share cannot be read is not vouched for.
			return false;
		}
	}
}
