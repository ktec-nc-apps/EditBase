<?php

declare(strict_types=1);

namespace OCA\EditBase\Controller;

use OCA\EditBase\AppInfo\Application;
use OCA\EditBase\Service\DocumentService;
use OCA\EditBase\Service\Connectors;
use OCA\EditBase\Service\FileBrowser;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;
use OCP\L10N\IFactory;

class ApiController extends Controller {
	private const ALLOWED_THEMES = ['auto', 'dark', 'light'];

	public function __construct(
		IRequest $request,
		private DocumentService $documents,
		private FileBrowser $files,
		private Connectors $connectors,
		private IUserSession $userSession,
		private IConfig $config,
		private IFactory $l10nFactory,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	private function uid(): string {
		$user = $this->userSession->getUser();
		if ($user === null) {
			throw new NotPermittedException('not logged in');
		}
		return $user->getUID();
	}

	/** One place to turn the service's exceptions into honest status codes. */
	private function run(callable $fn): JSONResponse {
		try {
			return new JSONResponse($fn());
		} catch (NotFoundException $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		} catch (NotPermittedException $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_FORBIDDEN);
		} catch (\InvalidArgumentException $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		} catch (\Throwable $e) {
			return new JSONResponse(['error' => $e->getMessage()], Http::STATUS_INTERNAL_SERVER_ERROR);
		}
	}

	#[NoAdminRequired]
	public function getSettings(): JSONResponse {
		return $this->run(function () {
			$uid = $this->uid();
			return [
				'folder' => $this->documents->folderName($uid),
				'theme' => $this->config->getUserValue($uid, Application::APP_ID, 'theme', 'auto'),
				'language' => $this->config->getUserValue($uid, Application::APP_ID, 'language', 'auto'),
				'paper' => $this->config->getUserValue($uid, Application::APP_ID, 'paper', ''),
				'languages' => $this->availableLanguages(),
			];
		});
	}

	#[NoAdminRequired]
	public function saveSettings(): JSONResponse {
		return $this->run(function () {
			$uid = $this->uid();
			$folder = $this->request->getParam('folder');
			if (is_string($folder) && $folder !== '') {
				$this->documents->setFolderName($uid, $folder);
			}
			$theme = $this->request->getParam('theme');
			if (is_string($theme) && in_array($theme, self::ALLOWED_THEMES, true)) {
				$this->config->setUserValue($uid, Application::APP_ID, 'theme', $theme);
			}
			$language = $this->request->getParam('language');
			if (is_string($language) && $language !== '' && preg_match('/^[a-z]{2}(_[A-Za-z]{2,4})?$|^auto$/', $language)) {
				$this->config->setUserValue($uid, Application::APP_ID, 'language', $language);
			}
			// The paper setup a new document starts from (JSON, produced by the editor).
			$paper = $this->request->getParam('paper');
			if (is_string($paper) && strlen($paper) < 2000) {
				$this->config->setUserValue($uid, Application::APP_ID, 'paper', $paper);
			}
			return ['ok' => true];
		});
	}

	/**
	 * Translations for a language other than Nextcloud's own, so the app can be
	 * read in one language while the rest of the server stays in another.
	 */
	#[NoAdminRequired]
	public function getI18n(string $lang): JSONResponse {
		return $this->run(function () use ($lang) {
			if (!in_array($lang, $this->languageCodes(), true)) {
				throw new NotFoundException('unknown language');
			}
			$file = __DIR__ . '/../../l10n/' . $lang . '.json';
			if (!is_file($file)) {
				return ['translations' => new \stdClass()];
			}
			$data = json_decode((string)file_get_contents($file), true);
			return ['translations' => $data['translations'] ?? new \stdClass()];
		});
	}

	/**
	 * The bundled Google Fonts catalogue. It ships with the app rather than being
	 * fetched at run time, so the picker works before anything is loaded from Google
	 * — and on a server that cannot reach Google at all, the list is still there.
	 */
	#[NoAdminRequired]
	public function fonts(): JSONResponse {
		return $this->run(function () {
			$file = __DIR__ . '/../../data/google-fonts.json';
			if (!is_file($file)) {
				return ['families' => [], 'count' => 0];
			}
			$data = json_decode((string)file_get_contents($file), true);
			return is_array($data) ? $data : ['families' => [], 'count' => 0];
		});
	}

	#[NoAdminRequired]
	public function browseFiles(): JSONResponse {
		return $this->run(fn () => $this->files->browse($this->uid(), (string)($this->request->getParam('path') ?? '')));
	}

	#[NoAdminRequired]
	public function fileImage(int $id): JSONResponse {
		return $this->run(fn () => $this->files->image($this->uid(), $id));
	}

	// ---- the other apps on this server ----

	#[NoAdminRequired]
	public function sources(): JSONResponse {
		return $this->run(fn () => ['sources' => $this->connectors->available($this->uid())]);
	}

	#[NoAdminRequired]
	public function tables(): JSONResponse {
		return $this->run(fn () => ['tables' => $this->connectors->tables($this->uid())]);
	}

	#[NoAdminRequired]
	public function table(int $id): JSONResponse {
		return $this->run(fn () => $this->connectors->table($this->uid(), $id));
	}

	#[NoAdminRequired]
	public function contacts(): JSONResponse {
		return $this->run(fn () => ['contacts' => $this->connectors->contacts($this->uid(), (string)($this->request->getParam('q') ?? ''))]);
	}

	#[NoAdminRequired]
	public function calendars(): JSONResponse {
		return $this->run(fn () => ['calendars' => $this->connectors->calendars($this->uid())]);
	}

	#[NoAdminRequired]
	public function events(): JSONResponse {
		return $this->run(function () {
			$from = (string)($this->request->getParam('from') ?? '');
			$to = (string)($this->request->getParam('to') ?? '');
			if ($from === '' || $to === '') {
				throw new \InvalidArgumentException('a date range is required');
			}
			return ['events' => $this->connectors->events($this->uid(), $from, $to, (string)($this->request->getParam('calendar') ?? ''))];
		});
	}

	#[NoAdminRequired]
	public function regibaseCollections(): JSONResponse {
		return $this->run(fn () => ['collections' => $this->connectors->regibaseCollections($this->uid())]);
	}

	#[NoAdminRequired]
	public function regibaseRecords(int $id): JSONResponse {
		return $this->run(fn () => $this->connectors->regibaseRecords($this->uid(), $id));
	}

	#[NoAdminRequired]
	public function formulaCollections(): JSONResponse {
		return $this->run(fn () => ['collections' => $this->connectors->formulaCollections($this->uid())]);
	}

	#[NoAdminRequired]
	public function formulas(int $id): JSONResponse {
		return $this->run(fn () => ['formulas' => $this->connectors->formulas($this->uid(), $id)]);
	}

	#[NoAdminRequired]
	public function documents(): JSONResponse {
		return $this->run(fn () => ['documents' => $this->documents->list($this->uid())]);
	}

	#[NoAdminRequired]
	public function getDocument(int $id): JSONResponse {
		return $this->run(fn () => $this->documents->get($this->uid(), $id));
	}

	#[NoAdminRequired]
	public function createDocument(): JSONResponse {
		return $this->run(function () {
			$name = (string)($this->request->getParam('name') ?? 'Document');
			$content = (string)($this->request->getParam('content') ?? '');
			return $this->documents->create($this->uid(), $name, $content);
		});
	}

	#[NoAdminRequired]
	public function saveDocument(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$content = $this->request->getParam('content');
			if (!is_string($content)) {
				throw new \InvalidArgumentException('content missing');
			}
			return $this->documents->save($this->uid(), $id, $content);
		});
	}

	#[NoAdminRequired]
	public function renameDocument(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$name = (string)($this->request->getParam('name') ?? '');
			if ($name === '') {
				throw new \InvalidArgumentException('name missing');
			}
			return $this->documents->rename($this->uid(), $id, $name);
		});
	}

	#[NoAdminRequired]
	public function duplicateDocument(int $id): JSONResponse {
		return $this->run(fn () => $this->documents->duplicate($this->uid(), $id));
	}

	#[NoAdminRequired]
	public function deleteDocument(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$this->documents->delete($this->uid(), $id);
			return ['ok' => true];
		});
	}

	/** @return array<int, array<string, string>> */
	private function availableLanguages(): array {
		$names = [
			'ja' => '日本語', 'en' => 'English', 'zh' => '简体中文', 'es' => 'Español',
			'fr' => 'Français', 'de' => 'Deutsch', 'ru' => 'Русский', 'pt' => 'Português',
			'ar' => 'العربية', 'hi' => 'हिन्दी', 'ko' => '한국어', 'it' => 'Italiano',
		];
		$out = [];
		foreach (glob(__DIR__ . '/../../l10n/*.json') ?: [] as $path) {
			$code = basename($path, '.json');
			$out[] = ['code' => $code, 'name' => $names[$code] ?? $code];
		}
		return $out;
	}

	/** @return array<int, string> */
	private function languageCodes(): array {
		return array_map(static fn (array $l): string => $l['code'], $this->availableLanguages());
	}
}
