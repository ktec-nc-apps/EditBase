<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;

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
	/** A Markdown file is text; five megabytes of it is a book. */
	public const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;

	/** Whether a file is Markdown, by its name: the MIME type is not reliable for it. */
	public static function isMarkdown(string $name): bool {
		return (bool)preg_match('/\.(md|markdown|mdown|mkd)$/i', $name);
	}

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
				'is_markdown' => self::isMarkdown($name),
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
		// Put into a document, a picture is a copy of it (review S3).
		if (!Downloads::allowed($file)) {
			throw new NotPermittedException('whoever shared this picture does not allow it to be downloaded');
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

	/**
	 * A Markdown file's text, to be made into a document.
	 *
	 * The file itself is only read, never written: the document made from it is a
	 * new file, and the Markdown stays as it was.
	 *
	 * Text written on a Japanese Windows machine is often Shift_JIS rather than
	 * UTF-8; read as UTF-8 it comes out as garbage. TextEncoding works out what
	 * it is, so the browser always receives UTF-8 and is told what it was.
	 *
	 * @return array<string, mixed>
	 */
	public function markdown(string $userId, int $id): array {
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
		// Made into a document of one's own, a note is a copy of it (review S3).
		if (!Downloads::allowed($file)) {
			throw new NotPermittedException('whoever shared this note does not allow it to be downloaded');
		}
		if (!self::isMarkdown($file->getName())) {
			throw new \InvalidArgumentException('not a Markdown file');
		}
		if ($file->getSize() > self::MAX_MARKDOWN_BYTES) {
			throw new \InvalidArgumentException('file is larger than ' . (int)(self::MAX_MARKDOWN_BYTES / 1024 / 1024) . ' MB');
		}
		$read = TextEncoding::toUtf8((string)$file->getContent());
		return [
			'id' => $file->getId(),
			'name' => $file->getName(),
			'size' => $file->getSize(),
			'content' => $read['text'],
			'encoding' => [
				'read' => $read['encoding'],
				'declared' => $read['declared'],
				'mismatch' => $read['mismatch'],
				'lossy' => $read['lossy'],
			],
		];
	}
}
