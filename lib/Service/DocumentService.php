<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCA\EditBase\AppInfo\Application;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\IConfig;

/**
 * Documents are not rows in a table: they are ordinary .html files in the user's
 * own Files. That is the whole point of the app — what EditBase saves is the
 * finished artefact, so sharing, versioning, search and sync all come from
 * Nextcloud itself and nothing has to be exported to leave.
 *
 * This service therefore does no HTML parsing beyond reading the <title> for the
 * document list. The browser builds the file and the browser takes it apart again.
 */
class DocumentService {
	public const EXT = '.html';
	private const DEFAULT_FOLDER = 'EditBase';

	public function __construct(
		private IRootFolder $rootFolder,
		private IConfig $config,
	) {
	}

	public function folderName(string $userId): string {
		$name = $this->config->getUserValue($userId, Application::APP_ID, 'folder', self::DEFAULT_FOLDER);
		$name = trim($name, "/ \t\n\r\0\x0B");
		return $name === '' ? self::DEFAULT_FOLDER : $name;
	}

	public function setFolderName(string $userId, string $name): string {
		$name = trim($name, "/ \t\n\r\0\x0B");
		if ($name === '' || !$this->isSafePath($name)) {
			throw new \InvalidArgumentException('invalid folder name');
		}
		$this->config->setUserValue($userId, Application::APP_ID, 'folder', $name);
		return $name;
	}

	/** The save folder, created on first use. */
	public function folder(string $userId): Folder {
		$userFolder = $this->rootFolder->getUserFolder($userId);
		$path = $this->folderName($userId);
		try {
			$node = $userFolder->get($path);
			if ($node instanceof Folder) {
				return $node;
			}
		} catch (NotFoundException) {
			// fall through and create it
		}
		return $userFolder->newFolder($path);
	}

	/**
	 * Every .html file in the save folder, newest first.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function list(string $userId): array {
		$out = [];
		foreach ($this->folder($userId)->getDirectoryListing() as $node) {
			if (!($node instanceof File) || !$this->isHtml($node->getName())) {
				continue;
			}
			$out[] = $this->describe($node, false);
		}
		usort($out, static fn ($a, $b) => $b['mtime'] <=> $a['mtime']);
		return $out;
	}

	/** @return array<string, mixed> */
	public function get(string $userId, int $id): array {
		return $this->describe($this->file($userId, $id), true);
	}

	/** @return array<string, mixed> */
	public function create(string $userId, string $name, string $content): array {
		$folder = $this->folder($userId);
		$file = $folder->newFile($this->freeName($folder, $name), $content);
		return $this->describe($file, false);
	}

	/** @return array<string, mixed> */
	public function save(string $userId, int $id, string $content): array {
		$file = $this->file($userId, $id);
		$file->putContent($content);
		return $this->describe($file, false);
	}

	/** @return array<string, mixed> */
	public function duplicate(string $userId, int $id): array {
		$file = $this->file($userId, $id);
		$folder = $this->folder($userId);
		$base = $this->stripExt($file->getName());
		$copy = $folder->newFile($this->freeName($folder, $base . ' (2)'), $file->getContent());
		return $this->describe($copy, false);
	}

	/** @return array<string, mixed> */
	public function rename(string $userId, int $id, string $name): array {
		$file = $this->file($userId, $id);
		$target = $this->normaliseName($name);
		if ($target !== $file->getName()) {
			$folder = $file->getParent();
			// move() returns the node at its new home; the old handle keeps the old path.
			$moved = $file->move($folder->getPath() . '/' . $this->freeName($folder, $this->stripExt($target)));
			if ($moved instanceof File) {
				$file = $moved;
			} else {
				$file = $this->file($userId, $file->getId());
			}
		}
		return $this->describe($file, false);
	}

	public function delete(string $userId, int $id): void {
		$this->file($userId, $id)->delete();
	}

	public function readContent(string $userId, int $id): string {
		return $this->file($userId, $id)->getContent();
	}

	/**
	 * Resolve a file id inside the user's own storage. Going through the user
	 * folder is what keeps one user's id out of another user's document, and it
	 * also lets a document be opened from anywhere in Files, not just the save
	 * folder — the folder setting decides where new documents are created, not
	 * which ones may be opened.
	 */
	private function file(string $userId, int $id): File {
		$nodes = $this->rootFolder->getUserFolder($userId)->getById($id);
		foreach ($nodes as $node) {
			if ($node instanceof File) {
				if (!$this->isHtml($node->getName())) {
					throw new \InvalidArgumentException('not an HTML document');
				}
				return $node;
			}
		}
		throw new NotFoundException('document ' . $id . ' not found');
	}

	/** @return array<string, mixed> */
	private function describe(File $file, bool $withContent): array {
		$content = $withContent ? $file->getContent() : null;
		$out = [
			'id' => $file->getId(),
			'name' => $file->getName(),
			'title' => $this->stripExt($file->getName()),
			'path' => $file->getPath(),
			'size' => $file->getSize(),
			'mtime' => $file->getMTime(),
			'etag' => $file->getEtag(),
			'writable' => $file->isUpdateable(),
		];
		if ($withContent) {
			$out['content'] = $content;
		}
		return $out;
	}

	private function isHtml(string $name): bool {
		$lower = strtolower($name);
		return str_ends_with($lower, '.html') || str_ends_with($lower, '.htm');
	}

	private function stripExt(string $name): string {
		return preg_replace('/\.html?$/i', '', $name) ?? $name;
	}

	/** Turn whatever the user typed into one safe file name ending in .html. */
	private function normaliseName(string $name): string {
		$name = trim(str_replace(['/', '\\', "\0"], '', $name));
		// Leading dots would make a hidden file (and "..name" reads like a path trick
		// even though the slashes are already gone), so they go.
		$name = ltrim($name, ". \t");
		$name = $this->stripExt($name);
		if (trim($name) === '') {
			$name = 'Document';
		}
		return mb_substr($name, 0, 200) . self::EXT;
	}

	/** `Report.html`, then `Report (2).html`, … so a save never overwrites a stranger. */
	private function freeName(Folder $folder, string $base): string {
		$name = $this->normaliseName($base);
		if (!$folder->nodeExists($name)) {
			return $name;
		}
		$stem = $this->stripExt($name);
		for ($i = 2; $i < 1000; $i++) {
			$candidate = $stem . ' (' . $i . ')' . self::EXT;
			if (!$folder->nodeExists($candidate)) {
				return $candidate;
			}
		}
		return $stem . ' (' . time() . ')' . self::EXT;
	}

	/** A folder setting may nest, but it may not climb out of the user's home. */
	private function isSafePath(string $path): bool {
		foreach (explode('/', $path) as $part) {
			if ($part === '' || $part === '.' || $part === '..' || str_contains($part, "\0")) {
				return false;
			}
		}
		return true;
	}
}
