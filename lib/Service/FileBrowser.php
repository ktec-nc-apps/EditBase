<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;

/**
 * Browsing the user's own Files, so a picture can be put into a document.
 *
 * The picture is then embedded in the document as a data: URI rather than linked:
 * a document that points back at Nextcloud stops being a document the moment it
 * leaves Nextcloud, and this app exists to produce files that stand on their own.
 */
class FileBrowser {
	/** Big enough for a photograph, small enough not to exhaust PHP's memory. */
	public const MAX_BYTES = 24 * 1024 * 1024;
	private const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp'];

	public function __construct(
		private IRootFolder $rootFolder,
	) {
	}

	/**
	 * One folder's contents: directories first, then files, both by name.
	 *
	 * @return array<string, mixed>
	 */
	public function browse(string $userId, string $path): array {
		$userFolder = $this->rootFolder->getUserFolder($userId);
		$path = trim($path, '/');
		$node = $path === '' ? $userFolder : $userFolder->get($path);
		if (!($node instanceof Folder)) {
			throw new \InvalidArgumentException('not a folder');
		}
		$dirs = [];
		$files = [];
		foreach ($node->getDirectoryListing() as $child) {
			$name = $child->getName();
			$rel = ltrim(substr($child->getPath(), strlen($userFolder->getPath())), '/');
			if ($child instanceof Folder) {
				$dirs[] = ['name' => $name, 'path' => $rel, 'is_dir' => true];
				continue;
			}
			$mime = $child->getMimeType();
			$files[] = [
				'name' => $name,
				'path' => $rel,
				'is_dir' => false,
				'id' => $child->getId(),
				'mime' => $mime,
				'size' => $child->getSize(),
				'is_image' => in_array($mime, self::IMAGE_MIMES, true),
			];
		}
		$byName = static fn (array $a, array $b): int => strnatcasecmp($a['name'], $b['name']);
		usort($dirs, $byName);
		usort($files, $byName);
		return [
			'path' => $path,
			'parent' => $this->parentOf($path),
			'entries' => array_merge($dirs, $files),
		];
	}

	/** The folder above this one, '' for the home folder, null when already there. */
	private function parentOf(string $path): ?string {
		if ($path === '') {
			return null;
		}
		$up = dirname($path);
		return ($up === '.' || $up === '/' || $up === '') ? '' : $up;
	}

	/**
	 * One image, base64 encoded, ready to become a data: URI in the document.
	 *
	 * @return array<string, mixed>
	 */
	public function image(string $userId, int $id): array {
		$userFolder = $this->rootFolder->getUserFolder($userId);
		$file = null;
		foreach ($userFolder->getById($id) as $node) {
			if ($node instanceof File) {
				$file = $node;
				break;
			}
		}
		if ($file === null) {
			throw new NotFoundException('file ' . $id . ' not found');
		}
		if (!in_array($file->getMimeType(), self::IMAGE_MIMES, true)) {
			throw new \InvalidArgumentException('not an image');
		}
		if ($file->getSize() > self::MAX_BYTES) {
			throw new \InvalidArgumentException('image is larger than ' . (int)(self::MAX_BYTES / 1024 / 1024) . ' MB');
		}
		return [
			'id' => $file->getId(),
			'name' => $file->getName(),
			'mime' => $file->getMimeType(),
			'size' => $file->getSize(),
			'data' => base64_encode($file->getContent()),
		];
	}
}
