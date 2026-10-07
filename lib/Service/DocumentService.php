<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCA\EditBase\AppInfo\Application;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IConfig;
use OCP\IUserManager;
use OCP\Lock\ILockingProvider;
use OCP\Lock\LockedException;
use OCP\Share\IManager as IShareManager;
use OCP\Share\IShare;

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

	/** How long a save waits for another save of the same document to finish, in seconds. */
	private float $lockWait = 10.0;

	public function __construct(
		private IRootFolder $rootFolder,
		private IConfig $config,
		private IShareManager $shares,
		private IUserManager $users,
		private VersionService $versions,
		private DocumentCheck $check,
		private ILockingProvider $locking,
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
		// The name must be a folder's, or a place where one can be made. The name
		// of a file was accepted, and every listing after it failed with "not
		// permitted" until the setting was changed back (review 2026-10-04, 低9).
		$this->fileInTheWay($this->rootFolder->getUserFolder($userId), $name);
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
		// A file put there since the name was set: said plainly, not as "not permitted".
		$this->fileInTheWay($userFolder, $path);
		return $userFolder->newFolder($path);
	}

	/**
	 * Refuse a folder path that runs into a file: at the path itself, or at any
	 * folder on the way to it.
	 */
	private function fileInTheWay(Folder $userFolder, string $path): void {
		$walk = '';
		foreach (explode('/', $path) as $part) {
			$walk = $walk === '' ? $part : $walk . '/' . $part;
			try {
				$node = $userFolder->get($walk);
			} catch (NotFoundException) {
				return;
			}
			if (!($node instanceof Folder)) {
				throw new \InvalidArgumentException('there is a file called ' . $walk . ' there already');
			}
		}
	}

	/**
	 * Every document the user can open: the .html files in the save folder and in
	 * the folders inside it, and the ones other people have shared with them.
	 * Each one says which folder it is in, so the list can be a list of folders.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function list(string $userId): array {
		$out = [];
		$seen = [];
		// What one listing may read to mark files it has not seen before (S14).
		$this->check->beginListing();
		$this->gather($this->folder($userId), '', $out, $seen);
		foreach ($this->sharedWithMe($userId) as $item) {
			if (isset($seen[$item['id']])) {
				continue;
			}
			$seen[$item['id']] = true;
			$out[] = $item;
		}
		usort($out, static fn ($a, $b) => $b['mtime'] <=> $a['mtime']);
		return $out;
	}

	/**
	 * The folders the documents are kept in, in order, including the empty ones --
	 * a folder made and not yet written in is still a place to put something.
	 *
	 * @return array<int, string>
	 */
	public function folders(string $userId): array {
		$out = [];
		$this->gatherFolders($this->folder($userId), '', $out);
		sort($out, SORT_NATURAL | SORT_FLAG_CASE);
		return $out;
	}

	/** Make a folder to keep documents in, inside the save folder. */
	public function makeFolder(string $userId, string $path): string {
		$path = $this->cleanFolder($path);
		if ($path === '') {
			throw new \InvalidArgumentException('a folder needs a name');
		}
		$folder = $this->folder($userId);
		$here = $folder;
		foreach (explode('/', $path) as $part) {
			$here = $here->nodeExists($part) ? $here->get($part) : $here->newFolder($part);
			if (!($here instanceof Folder)) {
				throw new \InvalidArgumentException('there is a file called ' . $part . ' there already');
			}
		}
		return $path;
	}

	/**
	 * The id of a category, so that it can be shared like anything else. The save
	 * folder itself is not one: sharing that would hand over every document there
	 * is, which is not what anyone means by sharing a category.
	 */
	public function folderId(string $userId, string $path): int {
		$path = $this->cleanFolder($path);
		if ($path === '') {
			throw new \InvalidArgumentException('the whole of your own folder is not a category');
		}
		$node = $this->folder($userId)->get($path);
		if (!($node instanceof Folder)) {
			throw new \InvalidArgumentException('that is not a category');
		}
		return $node->getId();
	}

	/**
	 * Delete a category -- an empty one only (owner 2026-09-29, BUGS #299): a
	 * category with anything in it is refused, so no document goes with it.
	 * The folder goes to Nextcloud's trash like any deleted folder.
	 */
	public function deleteFolder(string $userId, string $path): void {
		$path = $this->cleanFolder($path);
		if ($path === '') {
			throw new \InvalidArgumentException('the whole of your own folder is not a category');
		}
		$node = $this->folder($userId)->get($path);
		if (!($node instanceof Folder)) {
			throw new \InvalidArgumentException('that is not a category');
		}
		if (count($node->getDirectoryListing()) > 0) {
			throw new \InvalidArgumentException('not empty');
		}
		$node->delete();
	}

	/** Put a document in another folder, or back at the top with an empty path. */
	public function move(string $userId, int $id, string $path): array {
		$file = $this->file($userId, $id);
		$path = $this->cleanFolder($path);
		$target = $this->folder($userId);
		if ($path !== '') {
			$this->makeFolder($userId, $path);
			$node = $target->get($path);
			if (!($node instanceof Folder)) {
				throw new \InvalidArgumentException('that is not a folder');
			}
			$target = $node;
		}
		if ($file->getParent()->getId() === $target->getId()) {
			return $this->describe($file, false);
		}
		// Moving is taking it out of one folder and putting it in another, and each
		// half needs its own permission -- which is what Files asks for too (review
		// S6). The move itself would only look at the second.
		if (!$file->isDeletable()) {
			throw new NotPermittedException('this document may not be taken out of the folder it is in');
		}
		if (!$target->isCreatable()) {
			throw new NotPermittedException('that category is read only');
		}
		// Out of a share that does not allow downloading is out of the share (S3).
		if ($file->getMountPoint()->getMountPoint() !== $target->getMountPoint()->getMountPoint() && !Downloads::allowed($file)) {
			throw new NotPermittedException('whoever shared this document does not allow it to be downloaded');
		}
		$was = $file->getParent();
		$wasCalled = $file->getName();
		$moved = $file->move($target->getPath() . '/' . $this->freeName($target, $this->stripExt($file->getName())));
		$file = $moved instanceof File ? $moved : $this->file($userId, $id);
		// The versions go with it, into the same category.
		$this->versions->follow($was, $wasCalled, $file);
		return $this->describe($file, false, $path);
	}

	/**
	 * Every document under a folder, with the folder it is in written on it. Only
	 * so deep: a folder inside a folder inside a folder is somebody's file tree,
	 * not a list of documents, and walking all of it would read the whole account.
	 *
	 * @param array<int, array<string, mixed>> $out
	 * @param array<int, bool> $seen
	 */
	private function gather(Folder $folder, string $path, array &$out, array &$seen, int $depth = 0): void {
		foreach ($folder->getDirectoryListing() as $node) {
			if ($node instanceof Folder) {
				if ($depth < 4) {
					$this->gather($node, $path === '' ? $node->getName() : $path . '/' . $node->getName(), $out, $seen, $depth + 1);
				}
				continue;
			}
			if (!($node instanceof File) || !$this->isHtml($node->getName()) || isset($seen[$node->getId()])) {
				continue;
			}
			$seen[$node->getId()] = true;
			$out[] = $this->withCheck($this->describe($node, false, $path), $node);
		}
	}

	/**
	 * A list row, with what EditBase would have to take out of the file to open it
	 * (null for a file it handles as it is). The list marks the ones it does not.
	 *
	 * @param array<string, mixed> $row
	 * @return array<string, mixed>
	 */
	private function withCheck(array $row, File $file): array {
		$seen = $this->check->forFile($file);
		$row['unsupported'] = $seen['found'];
		// Carries EditBase's own program (checked by its fingerprint): the list
		// marks it "JS", so it is known before it is opened.
		$row['script'] = $seen['script'];
		return $row;
	}

	/** @param array<int, string> $out */
	private function gatherFolders(Folder $folder, string $path, array &$out, int $depth = 0): void {
		foreach ($folder->getDirectoryListing() as $node) {
			if (!($node instanceof Folder)) {
				continue;
			}
			$here = $path === '' ? $node->getName() : $path . '/' . $node->getName();
			$out[] = $here;
			if ($depth < 4) {
				$this->gatherFolders($node, $here, $out, $depth + 1);
			}
		}
	}

	/**
	 * The documents other people on this server have shared with this user, whether
	 * they shared one document or a whole folder of them. They are listed under the
	 * name of whoever shared them, because that is how a person looks for them.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function sharedWithMe(string $userId): array {
		$out = [];
		$seen = [];
		$mine = $this->rootFolder->getUserFolder($userId);
		foreach ([IShare::TYPE_USER, IShare::TYPE_GROUP] as $type) {
			foreach ($this->shares->getSharedWith($userId, $type, null, 200) as $share) {
				// The share as this user has it -- where it is in their own Files, and
				// what they may do with it -- not as its owner has it (review S11): the
				// owner's own folders are not this user's to see, and the owner may
				// write in what this user may only read. A share this user declined, or
				// has not yet accepted, is not in their Files, and is not listed.
				$node = null;
				try {
					foreach ($mine->getById($share->getNodeId()) as $candidate) {
						if ($candidate instanceof File || $candidate instanceof Folder) {
							$node = $candidate;
							break;
						}
					}
				} catch (\Throwable) {
					$node = null;
				}
				if ($node === null) {
					continue;
				}
				$owner = $this->nameOf($share->getShareOwner());
				if ($node instanceof Folder) {
					$inside = [];
					$this->gather($node, $node->getName(), $inside, $seen);
					foreach ($inside as $item) {
						$item['owner'] = $owner;
						$item['shared'] = true;
						$out[] = $item;
					}
					continue;
				}
				if (!($node instanceof File) || !$this->isHtml($node->getName()) || isset($seen[$node->getId()])) {
					continue;
				}
				$seen[$node->getId()] = true;
				$item = $this->withCheck($this->describe($node, false, ''), $node);
				// A document shared on its own keeps the number of the folder it is
				// in on its owner's side, as it always has: the list files it under
				// "Shared with me" by it, and it is not a folder this user can see.
				try {
					$item['folderId'] = $share->getNode()->getParent()->getId();
				} catch (\Throwable) {
					// kept as this user sees it
				}
				$item['owner'] = $owner;
				$item['shared'] = true;
				$out[] = $item;
			}
		}
		return $out;
	}

	private function nameOf(string $uid): string {
		$user = $this->users->get($uid);
		return $user === null ? $uid : $user->getDisplayName();
	}

	/** A folder path a user typed: no climbing out, no empty parts, not too deep. */
	private function cleanFolder(string $path): string {
		$parts = [];
		foreach (explode('/', str_replace('\\', '/', trim($path))) as $part) {
			$part = trim($part);
			if ($part === '' || $part === '.' ) {
				continue;
			}
			if ($part === '..' || str_contains($part, "\0")) {
				throw new \InvalidArgumentException('that is not a folder name');
			}
			$parts[] = mb_substr($part, 0, 100);
		}
		return implode('/', array_slice($parts, 0, 5));
	}

	/** @return array<string, mixed> */
	public function get(string $userId, int $id): array {
		return $this->describe($this->file($userId, $id), true);
	}

	/** @return array<string, mixed> */
	public function create(string $userId, string $name, string $content, string $path = '', int $folderId = 0): array {
		$folder = $this->folder($userId);
		// A category somebody else shared: it is not inside this user's own save
		// folder, so it is found by its id rather than by a path from there.
		if ($folderId > 0) {
			$where = null;
			foreach ($this->rootFolder->getUserFolder($userId)->getById($folderId) as $node) {
				if ($node instanceof Folder) {
					$where = $node;
					break;
				}
			}
			if ($where === null) {
				throw new NotFoundException('that category is not there');
			}
			if (!$where->isCreatable()) {
				throw new \OCP\Files\NotPermittedException('that category is read only');
			}
			$file = $where->newFile($this->freeName($where, $name), $content);
			return $this->describe($file, false, $where->getName());
		}
		$path = $this->cleanFolder($path);
		if ($path !== '') {
			$this->makeFolder($userId, $path);
			$node = $folder->get($path);
			if ($node instanceof Folder) {
				$folder = $node;
			}
		}
		$file = $folder->newFile($this->freeName($folder, $name), $content);
		return $this->describe($file, false, $path);
	}

	/**
	 * Write a document back.
	 *
	 * If the writer says which version they started from, and the file has moved
	 * on since -- somebody else writing in the same document -- nothing is written
	 * and the version that is there is handed back instead, for the editor to take
	 * the other person's paragraphs into its own copy and try again. Without that
	 * check the last save would quietly throw the other person's work away.
	 *
	 * @return array<string, mixed>
	 */
	public function save(string $userId, int $id, string $content, string $etag = '', bool $manual = false): array {
		// The check and the write are one step (review S4). A second save of the
		// same document waits for the first to finish, then looks again at what is
		// there: two writers who both started from the same version used to both
		// pass the check, and the one who wrote last threw the other's work away
		// while both were told their save had gone in.
		return $this->oneAtATime($this->file($userId, $id), function () use ($userId, $id, $content, $etag, $manual): array {
			// Looked up again inside: what was there before the wait may not be there now.
			$file = $this->file($userId, $id);
			if ($etag !== '' && $file->getEtag() !== $etag) {
				$out = $this->describe($file, true);
				$out['stale'] = true;
				return $out;
			}
			// The version is of what is there now, taken before it is written over --
			// on every save, or only on the ones the writer asked for, as they choose.
			$keep = $this->versions->keep($userId);
			if ($keep > 0 && ($manual || $this->versions->when($userId) === 'auto') && $file->getSize() > 0) {
				try {
					$this->versions->take($file, $keep);
				} catch (\Throwable) {
					// A version that cannot be taken must not cost the writer their save.
				}
			}
			$file->putContent($content);
			return $this->describe($file, false);
		});
	}

	/**
	 * Run $write while holding this document against every other write through
	 * EditBase. Nextcloud's own locking does the holding, under a name of the
	 * app's own, so the file's own locks -- which the write takes -- are left alone.
	 *
	 * @template T
	 * @param callable(): T $write
	 * @return T
	 */
	private function oneAtATime(File $file, callable $write): mixed {
		$key = 'editbase/save/' . $file->getId();
		$until = microtime(true) + $this->lockWait;
		while (true) {
			try {
				$this->locking->acquireLock($key, ILockingProvider::LOCK_EXCLUSIVE, $file->getName());
				break;
			} catch (LockedException) {
				if (microtime(true) >= $until) {
					throw new \RuntimeException('somebody else is saving this document; try again in a moment');
				}
				usleep(50000);
			}
		}
		try {
			return $write();
		} finally {
			$this->locking->releaseLock($key, ILockingProvider::LOCK_EXCLUSIVE);
		}
	}

	/** The versions kept beside a document, newest first. */
	public function versions(string $userId, int $id): array {
		return $this->versions->list($this->file($userId, $id));
	}

	public function readVersion(string $userId, int $id, int $number): string {
		return $this->versions->read($this->file($userId, $id), $number);
	}

	/** @return array<string, mixed> */
	public function restoreVersion(string $userId, int $id, int $number): array {
		// Putting a version back writes the document, so it waits its turn like a save.
		return $this->oneAtATime($this->file($userId, $id), function () use ($userId, $id, $number): array {
			$this->versions->restore($this->file($userId, $id), $number, $this->versions->keep($userId));
			return $this->describe($this->file($userId, $id), true);
		});
	}

	/** What version the file is at now, without reading the whole of it. */
	public function state(string $userId, int $id): array {
		$file = $this->file($userId, $id);
		return [
			'id' => $file->getId(),
			'etag' => $file->getEtag(),
			'mtime' => $file->getMTime(),
			'size' => $file->getSize(),
			'writable' => $file->isUpdateable(),
		];
	}

	/** @return array<string, mixed> */
	public function duplicate(string $userId, int $id): array {
		$file = $this->file($userId, $id);
		// A copy in one's own folder is a download by another name (review S3).
		if (!Downloads::allowed($file)) {
			throw new NotPermittedException('whoever shared this document does not allow it to be downloaded');
		}
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
			$was = $file->getName();
			// move() returns the node at its new home; the old handle keeps the old path.
			$moved = $file->move($folder->getPath() . '/' . $this->freeName($folder, $this->stripExt($target)));
			if ($moved instanceof File) {
				$file = $moved;
			} else {
				$file = $this->file($userId, $file->getId());
			}
			$this->versions->follow($folder, $was, $file);
		}
		return $this->describe($file, false);
	}

	public function delete(string $userId, int $id): void {
		$file = $this->file($userId, $id);
		// The versions of a document are of that document: they go with it, into
		// the same trash, where they can be fetched back together.
		$this->versions->drop($file);
		$file->delete();
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
	private function describe(File $file, bool $withContent, ?string $folder = null): array {
		$content = $withContent ? $file->getContent() : null;
		$out = [
			'id' => $file->getId(),
			'name' => $file->getName(),
			'title' => $this->stripExt($file->getName()),
			'path' => $file->getPath(),
			'folder' => $folder ?? '',
			'folderId' => $file->getParent()->getId(),
			'size' => $file->getSize(),
			'mtime' => $file->getMTime(),
			'etag' => $file->getEtag(),
			'writable' => $file->isUpdateable(),
			// False for a document whose share does not allow downloading: it can be
			// read and written in, not copied away (S3), and the editor can say so.
			'download' => Downloads::allowed($file),
			'shared' => false,
			'owner' => '',
		];
		if ($withContent) {
			// Whatever the file was written in, the browser is handed UTF-8, and told
			// what it was read as -- a document from elsewhere in Shift_JIS could not
			// be opened at all before this (see TextEncoding).
			$read = TextEncoding::htmlToUtf8((string)$content);
			$out['content'] = $read['text'];
			$out['encoding'] = [
				'read' => $read['encoding'],
				'declared' => $read['declared'],
				'mismatch' => $read['mismatch'],
				'lossy' => $read['lossy'],
			];
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
