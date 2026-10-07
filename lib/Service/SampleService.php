<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCA\EditBase\AppInfo\Application;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\NotFoundException;
use OCP\IConfig;
use Psr\Log\LoggerInterface;

/**
 * The sample documents that come with the app, laid out in EditBase: an
 * introduction, a quick manual and the other apps from the same makers. Each user
 * is given them once, the first time they open the document list after the app was
 * installed or upgraded to a version with new samples, in a category of their own.
 *
 * A user's own work is never touched. A sample that is still exactly as it was
 * shipped is replaced by the new one; one that has been edited is left alone, and
 * one that has been deleted is not put back until there are new samples.
 */
class SampleService {
	/** Raise this whenever a file in samples/ changes. */
	public const VERSION = '6';
	/** The category the samples go in: the same name in every language (owner 2026-10-02). */
	private const CATEGORY = 'Sample';
	private const FILES = ['Information.html', 'QuickManual.html', 'OtherApps.html'];

	public function __construct(
		private DocumentService $documents,
		private IConfig $config,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * What tells a sample that has been written in from one that has not: the words
	 * on its pages, not the bytes of the file. The file is rewritten by the editor as
	 * soon as it is opened and saved -- the stylesheet of the version that saved it,
	 * the names of the blocks -- and compared byte by byte, a sample nobody had
	 * touched counted as edited and was never replaced (the owner's QuickManual,
	 * 2026-10-03, #424).
	 */
	public static function fingerprint(string $html): string {
		$body = preg_replace('/<(script|style)\b[^>]*>.*?<\/\1>/si', ' ', $html) ?? $html;
		if (preg_match('/<body\b[^>]*>(.*)<\/body>/si', $body, $m)) {
			$body = $m[1];
		}
		$text = html_entity_decode(strip_tags($body), ENT_QUOTES | ENT_HTML5, 'UTF-8');
		$text = preg_replace('/\s+/u', ' ', $text) ?? $text;
		return hash('sha256', trim($text));
	}

	/** Give the user the samples if they have not had this version of them. Never throws. */
	public function ensure(string $userId): void {
		try {
			if ($this->config->getUserValue($userId, Application::APP_ID, 'sampleVersion', '') === self::VERSION) {
				return;
			}
			$hashes = json_decode($this->config->getUserValue($userId, Application::APP_ID, 'sampleHashes', '{}'), true);
			if (!is_array($hashes)) {
				$hashes = [];
			}
			// 見本が揃っていなければ何もしない（受け取り済みの印だけ付いて、見本が永久に届かなくなる）
			foreach (self::FILES as $name) {
				if (!is_readable(dirname(__DIR__, 2) . '/samples/' . $name)) {
					return;
				}
			}
			$category = $this->category($this->documents->folder($userId), self::CATEGORY);
			foreach (self::FILES as $name) {
				$source = dirname(__DIR__, 2) . '/samples/' . $name;
				$content = @file_get_contents($source);
				if ($content === false) {
					return;
				}
				if ($category->nodeExists($name)) {
					$node = $category->get($name);
					// 手を入れていない見本（送った時のまま）だけを差し替える
					if (!($node instanceof File) || !isset($hashes[$name]) || self::fingerprint($node->getContent()) !== $hashes[$name]) {
						continue;
					}
					$node->putContent($content);
				} else {
					$category->newFile($name, $content);
				}
				$hashes[$name] = self::fingerprint($content);
			}
			$this->config->setUserValue($userId, Application::APP_ID, 'sampleHashes', json_encode($hashes));
			$this->config->setUserValue($userId, Application::APP_ID, 'sampleVersion', self::VERSION);
		} catch (\Throwable $e) {
			$this->logger->warning('EditBase could not give the sample documents: ' . $e->getMessage(), ['app' => Application::APP_ID]);
		}
	}

	private function category(Folder $base, string $name): Folder {
		try {
			$node = $base->get($name);
			if ($node instanceof Folder) {
				return $node;
			}
		} catch (NotFoundException) {
			// fall through and create it
		}
		return $base->newFolder($name);
	}
}
