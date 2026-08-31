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
 * Keeping the last few versions of a document beside it.
 *
 * A version is an ordinary file in the same folder, named after the document
 * with its extension replaced by a number: 報告書.html keeps 報告書.#01, which is
 * always the most recent, and the older ones shift down as new ones are made.
 * They are plain HTML like everything else here, so a version can be opened,
 * printed or picked apart with nothing but a browser -- and Nextcloud's own
 * versions, trash and sync still apply to them as they do to any file.
 */
class VersionService {
	public const MAX = 99;
	private const DEFAULT_KEEP = 10;

	public function __construct(
		private IRootFolder $rootFolder,
		private IConfig $config,
	) {
	}

	/** How many versions this user keeps; nought means the feature is off. */
	public function keep(string $userId): int {
		$n = (int)$this->config->getUserValue($userId, Application::APP_ID, 'versionKeep', (string)self::DEFAULT_KEEP);
		return max(0, min(self::MAX, $n));
	}

	public function setKeep(string $userId, int $n): int {
		$n = max(0, min(self::MAX, $n));
		$this->config->setUserValue($userId, Application::APP_ID, 'versionKeep', (string)$n);
		return $n;
	}

	/** When a version is taken: every save, or only the ones the writer asks for. */
	public function when(string $userId): string {
		$when = $this->config->getUserValue($userId, Application::APP_ID, 'versionWhen', 'manual');
		return $when === 'auto' ? 'auto' : 'manual';
	}

	public function setWhen(string $userId, string $when): string {
		$when = $when === 'auto' ? 'auto' : 'manual';
		$this->config->setUserValue($userId, Application::APP_ID, 'versionWhen', $when);
		return $when;
	}

	/**
	 * Put the document as it stands now into #01, shifting what was there down.
	 * Called before the new content is written, so #01 is always the version
	 * before the save that has just happened.
	 */
	public function take(File $file, int $keep): void {
		if ($keep < 1) {
			return;
		}
		$folder = $file->getParent();
		$stem = $this->stem($file->getName());
		// The last one falls off the end.
		$oldest = $this->slot($folder, $stem, $keep);
		if ($oldest !== null) {
			$oldest->delete();
		}
		for ($i = $keep - 1; $i >= 1; $i--) {
			$node = $this->slot($folder, $stem, $i);
			if ($node === null) {
				continue;
			}
			$node->move($folder->getPath() . '/' . $this->name($stem, $i + 1));
		}
		$folder->newFile($this->name($stem, 1), $file->getContent());
	}

	/**
	 * The versions of a document, newest first.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function list(File $file): array {
		$folder = $file->getParent();
		$stem = $this->stem($file->getName());
		$out = [];
		for ($i = 1; $i <= self::MAX; $i++) {
			$node = $this->slot($folder, $stem, $i);
			if ($node === null) {
				continue;
			}
			$out[] = [
				'number' => $i,
				'name' => $node->getName(),
				'size' => $node->getSize(),
				'mtime' => $node->getMTime(),
			];
		}
		return $out;
	}

	/** What one version holds. */
	public function read(File $file, int $number): string {
		$node = $this->slot($file->getParent(), $this->stem($file->getName()), $number);
		if ($node === null) {
			throw new NotFoundException('there is no version ' . $number);
		}
		return $node->getContent();
	}

	/**
	 * Put a version back. What is there now becomes #01 first, so that going back
	 * can itself be gone back on.
	 */
	public function restore(File $file, int $number, int $keep): string {
		$content = $this->read($file, $number);
		$this->take($file, $keep);
		$file->putContent($content);
		return $content;
	}

	/**
	 * The versions of a document, wherever they are. Given by the folder and the
	 * name the document had, because they are looked for both before and after
	 * the document itself has moved.
	 *
	 * @return array<int, File>
	 */
	public function slotsOf(Folder $folder, string $name): array {
		$stem = $this->stem($name);
		$out = [];
		for ($i = 1; $i <= self::MAX; $i++) {
			$node = $this->slot($folder, $stem, $i);
			if ($node !== null) {
				$out[$i] = $node;
			}
		}
		return $out;
	}

	/**
	 * The versions follow the document: renamed with it, and moved with it. A
	 * backup that no longer answers to the name of the thing it is a backup of is
	 * no use to anybody, and would be picked up by the next document to take that
	 * name.
	 */
	public function follow(Folder $wasIn, string $wasCalled, File $file): void {
		$stem = $this->stem($file->getName());
		$folder = $file->getParent();
		if ($wasIn->getId() === $folder->getId() && $this->stem($wasCalled) === $stem) {
			return;
		}
		foreach ($this->slotsOf($wasIn, $wasCalled) as $number => $node) {
			$target = $folder->getPath() . '/' . $this->name($stem, $number);
			try {
				$node->move($target);
			} catch (\Throwable) {
				// One that will not move is left where it is rather than lost.
			}
		}
	}

	/** The versions go with the document when it goes. */
	public function drop(File $file): void {
		foreach ($this->slotsOf($file->getParent(), $file->getName()) as $node) {
			try {
				$node->delete();
			} catch (\Throwable) {
				// Nothing to be done about one that will not go.
			}
		}
	}

	private function slot(Folder $folder, string $stem, int $number): ?File {
		$name = $this->name($stem, $number);
		if (!$folder->nodeExists($name)) {
			return null;
		}
		$node = $folder->get($name);
		return $node instanceof File ? $node : null;
	}

	private function name(string $stem, int $number): string {
		return $stem . '.#' . str_pad((string)$number, 2, '0', STR_PAD_LEFT);
	}

	private function stem(string $name): string {
		return preg_replace('/\.html?$/i', '', $name) ?? $name;
	}
}
