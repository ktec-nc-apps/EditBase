<?php

declare(strict_types=1);

namespace OCA\EditBase\Controller;

use OCA\EditBase\AppInfo\Application;
use OCA\EditBase\Service\DocumentService;
use OCA\EditBase\Service\Connectors;
use OCA\EditBase\Service\FileBrowser;
use OCA\EditBase\Service\TextEncoding;
use OCA\EditBase\Service\ShareService;
use OCA\EditBase\Service\SessionService;
use OCA\EditBase\Service\LiveService;
use OCA\EditBase\Service\VersionService;
use OCA\EditBase\Service\FetchRefused;
use OCA\EditBase\Service\WebFetch;
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
		private ShareService $sharing,
		private SessionService $sessions,
		private LiveService $live,
		private VersionService $versions,
		private IUserSession $userSession,
		private IConfig $config,
		private IFactory $l10nFactory,
		private WebFetch $web,
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
		} catch (FetchRefused $e) {
			return new JSONResponse(['error' => $e->getMessage()], $e->status());
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
				// How many versions of a document are kept beside it, and when one
				// is taken: every save, or only the ones the writer asks for.
				'versionKeep' => $this->versions->keep($uid),
				'versionWhen' => $this->versions->when($uid),
				// How a newly placed object stands: by the rules of HTML, or freely.
				'placement' => $this->config->getUserValue($uid, Application::APP_ID, 'placement', 'standard'),
				// Whether Delete / Backspace may delete a frame that is selected (off unless chosen).
				'keyDelete' => $this->config->getUserValue($uid, Application::APP_ID, 'keyDelete', '0'),
				// Whether spaces (half-width, full-width, tabs) are marked on the page (off unless chosen).
				'showSpaces' => $this->config->getUserValue($uid, Application::APP_ID, 'showSpaces', '0'),
				// The unit indents are shown and written in: pt (the default), mm, or characters (em).
				'indentUnit' => $this->config->getUserValue($uid, Application::APP_ID, 'indentUnit', 'pt'),
				// The unit the ruler is marked in and moves by: pt, px, mm, cm (the default) or inches.
				'rulerUnit' => $this->config->getUserValue($uid, Application::APP_ID, 'rulerUnit', 'cm'),
				// A new document on a grid of characters and lines; the grid drawn on screen (both off unless chosen).
				'gridNew' => $this->config->getUserValue($uid, Application::APP_ID, 'gridNew', '0'),
				'showGrid' => $this->config->getUserValue($uid, Application::APP_ID, 'showGrid', '0'),
				// What the Tab key does outside a table: 'indent' (as before) or 'tab' (a tab that lines the words up).
				'tabKey' => $this->config->getUserValue($uid, Application::APP_ID, 'tabKey', 'indent'),
				'cellEnter' => $this->config->getUserValue($uid, Application::APP_ID, 'cellEnter', 'br'),
				// What colour each category is drawn in, as the writer chose.
				'folderColours' => $this->config->getUserValue($uid, Application::APP_ID, 'folderColours', ''),
				'docOrder' => $this->config->getUserValue($uid, Application::APP_ID, 'docOrder', ''),
				'languages' => $this->availableLanguages(),
				// What the browser has loaded is not always what is on the server:
				// a page left open goes on running the code it started with. This is
				// how the app can tell, and say so, instead of the writer finding a
				// fault that was mended an hour ago.
				'build' => $this->buildStamp(),
			];
		});
	}

	/** The build the server is serving: the app's own script, by size and time. */
	private function buildStamp(): string {
		$file = __DIR__ . '/../../js/editbase.dist.js';
		if (!is_readable($file)) {
			return '';
		}
		return substr(md5((string)filemtime($file) . ':' . (string)filesize($file)), 0, 12);
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
			$keep = $this->request->getParam('versionKeep');
			if ($keep !== null && $keep !== '') {
				$this->versions->setKeep($uid, (int)$keep);
			}
			$when = $this->request->getParam('versionWhen');
			if (is_string($when) && $when !== '') {
				$this->versions->setWhen($uid, $when);
			}
			$placement = $this->request->getParam('placement');
			if ($placement === 'standard' || $placement === 'free') {
				$this->config->setUserValue($uid, Application::APP_ID, 'placement', $placement);
			}
			$keyDelete = $this->request->getParam('keyDelete');
			if ($keyDelete === '1' || $keyDelete === '0') {
				$this->config->setUserValue($uid, Application::APP_ID, 'keyDelete', $keyDelete);
			}
			$showSpaces = $this->request->getParam('showSpaces');
			if ($showSpaces === '1' || $showSpaces === '0') {
				$this->config->setUserValue($uid, Application::APP_ID, 'showSpaces', $showSpaces);
			}
			$indentUnit = $this->request->getParam('indentUnit');
			if ($indentUnit === 'pt' || $indentUnit === 'mm' || $indentUnit === 'ch') {
				$this->config->setUserValue($uid, Application::APP_ID, 'indentUnit', $indentUnit);
			}
			$rulerUnit = $this->request->getParam('rulerUnit');
			$tabKey = $this->request->getParam('tabKey');
			if ($tabKey === 'indent' || $tabKey === 'tab') {
				$this->config->setUserValue($uid, Application::APP_ID, 'tabKey', $tabKey);
			}
			$cellEnter = $this->request->getParam('cellEnter');
			if ($cellEnter === 'br' || $cellEnter === 'para') {
				$this->config->setUserValue($uid, Application::APP_ID, 'cellEnter', $cellEnter);
			}
			foreach (['gridNew', 'showGrid'] as $flag) {
				$v = $this->request->getParam($flag);
				if ($v === '1' || $v === '0') {
					$this->config->setUserValue($uid, Application::APP_ID, $flag, $v);
				}
			}
			if (in_array($rulerUnit, ['pt', 'px', 'mm', 'cm', 'in', 'col'], true)) {
				$this->config->setUserValue($uid, Application::APP_ID, 'rulerUnit', $rulerUnit);
			}
			$colours = $this->request->getParam('folderColours');
			if (is_string($colours) && strlen($colours) < 4000) {
				$this->config->setUserValue($uid, Application::APP_ID, 'folderColours', $colours);
			}
			// 文書一覧の並び順（カテゴリごとの文書の id の並び）。手で並べ替えたときだけ書く。
			$order = $this->request->getParam('docOrder');
			if (is_string($order) && strlen($order) < 200000) {
				$parsed = json_decode($order, true);
				if (is_array($parsed)) {
					$clean = [];
					foreach ($parsed as $cat => $ids) {
						// 鍵は「c:カテゴリ名」：数字だけの名前でも配列にならないように
						if (is_string($cat) && strncmp($cat, 'c:', 2) === 0 && strlen($cat) < 300 && is_array($ids)) {
							$clean[$cat] = array_values(array_map('intval', array_filter($ids, 'is_numeric')));
						}
					}
					$this->config->setUserValue($uid, Application::APP_ID, 'docOrder', ($clean ? json_encode($clean, JSON_UNESCAPED_UNICODE) : '{}'));
				}
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
	/**
	 * Fetch a page from the web so its writing can be brought into a document.
	 * The browser cannot do this itself -- another site's page is not its to read --
	 * so the server asks for it and hands back the markup, which the editor then
	 * strips down to the writing. Only http and https, and never this server itself
	 * or a link-local address unless an administrator allows it (WebFetch, S1).
	 * The address handed back is the one the page was finally found at, after any
	 * redirects, so that what the page links to is read from the right place.
	 */
	#[NoAdminRequired]
	public function fetchPage(string $url): JSONResponse {
		return $this->run(function () use ($url) {
			$got = $this->web->get(
				$url,
				'text/html,application/xhtml+xml',
				WebFetch::PAGE_BYTES,
				true,
				// No Content-Type at all is taken for a page, as it always was.
				static fn (string $type): bool => $type === '' || stripos($type, 'html') !== false,
				'that address is not a web page',
				'that page is too large',
			);
			$read = $this->asUtf8($got['body'], $got['type']);
			return ['url' => $got['url'], 'html' => $read['text'], 'encoding' => [
				'read' => $read['encoding'],
				'declared' => $read['declared'],
				'mismatch' => $read['mismatch'],
				'lossy' => $read['lossy'],
			]];
		});
	}

	/**
	 * A picture on another site, for a document that shows it. Nextcloud's own
	 * policy will not let the editor load a picture from anywhere but this
	 * server, so every picture in a page brought in from the web -- or in a file
	 * or a Markdown note that points at one -- was an empty box (BUGS #75). The
	 * server reads it instead, the same way it reads the page, and the editor
	 * keeps it in the document the way it keeps a picture from Files.
	 */
	#[NoAdminRequired]
	public function fetchImage(string $url): JSONResponse {
		return $this->run(function () use ($url) {
			$mime = static fn (string $type): string => strtolower(trim(explode(';', $type)[0]));
			$got = $this->web->get(
				$url,
				'image/*',
				WebFetch::IMAGE_BYTES,
				false,
				static fn (string $type): bool => (bool)preg_match('#^image/(png|jpeg|gif|webp|svg\+xml|avif|bmp)$#', $mime($type)),
				'that address is not a picture',
				'that picture is too large',
			);
			return ['mime' => $mime($got['type']), 'data' => base64_encode($got['body'])];
		});
	}

	/**
	 * A page in the writing it was written in, turned into UTF-8.
	 *
	 * Half the Japanese web is still Shift_JIS -- Aozora Bunko, to name the one
	 * that matters -- and those bytes are not valid UTF-8. Handed to json_encode
	 * as they are, the whole answer comes back empty and the writer sees a page
	 * that brought in nothing at all, with nothing said about why.
	 */
	private function asUtf8(string $body, string $type): array {
		// What the server says comes first, then what the page says about itself --
		// but neither is believed over the bytes (see TextEncoding). A page served as
		// ISO-8859-1, which is what a server says when nobody told it anything, while
		// being written in UTF-8, used to come out as accented Latin letters.
		$said = TextEncoding::declaredInContentType($type);
		if ($said === '') {
			$said = TextEncoding::declaredInHtml($body);
		}
		return TextEncoding::htmlToUtf8($body, $said);
	}

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

	#[NoAdminRequired]
	public function fileMarkdown(int $id): JSONResponse {
		return $this->run(fn () => $this->files->markdown($this->uid(), $id));
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
	/**
	 * How the document stands, and who else has it open. This is what the editor
	 * asks every couple of seconds while a document is open: it is one small
	 * answer, and it is the whole of the co-writing machinery on the server.
	 */
	#[NoAdminRequired]
	public function documentState(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$state = $this->documents->state($this->uid(), $id);
			// Somebody who may only read the document is never shown as writing in it.
			$writing = (bool)($this->request->getParam('writing') ?? false) && !empty($state['writable']);
			$state['people'] = $this->sessions->beat($id, $this->uid(), $writing);
			return $state;
		});
	}

	#[NoAdminRequired]
	public function leaveDocument(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$this->sessions->leave($id, $this->uid());
			$this->live->leave($id, $this->uid());
			return ['ok' => true];
		});
	}

	/**
	 * The fast lane: what has just been typed here, and what the others have typed
	 * since this page last asked. Nothing is written to disk; the file is still
	 * saved the ordinary way, on its own timer.
	 */
	#[NoAdminRequired]
	public function liveDocument(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$uid = $this->uid();
			// Being allowed to read the file is what lets somebody take part: the
			// same check as opening it, and it throws if the document is not theirs
			// to see. Being allowed to write in the file is what lets what they send
			// be passed on to the others (review S2): a reader is shown the writing
			// as it happens, and nothing they send is taken.
			$state = $this->documents->state($uid, $id);
			$since = (int)($this->request->getParam('since') ?? 0);
			$blocks = $this->request->getParam('blocks');
			$where = $this->request->getParam('where');
			$out = $this->live->exchange(
				$id,
				$uid,
				$since,
				is_array($blocks) ? $blocks : [],
				is_array($where) ? $where : [],
				!empty($state['writable']),
			);
			$out['etag'] = $state['etag'];
			$out['writable'] = $state['writable'];
			return $out;
		});
	}

	#[NoAdminRequired]
	public function documentVersions(int $id): JSONResponse {
		return $this->run(fn () => ['versions' => $this->documents->versions($this->uid(), $id)]);
	}

	#[NoAdminRequired]
	public function readVersion(int $id, int $number): JSONResponse {
		return $this->run(fn () => ['content' => $this->documents->readVersion($this->uid(), $id, $number)]);
	}

	#[NoAdminRequired]
	public function restoreVersion(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$number = (int)($this->request->getParam('number') ?? 0);
			return $this->documents->restoreVersion($this->uid(), $id, $number);
		});
	}

	#[NoAdminRequired]
	public function folders(): JSONResponse {
		return $this->run(fn () => ['folders' => $this->documents->folders($this->uid())]);
	}

	/** A category's own id, so it can be shared the way a document is. */
	#[NoAdminRequired]
	public function folderId(): JSONResponse {
		return $this->run(function () {
			$path = (string)($this->request->getParam('path') ?? '');
			return ['id' => $this->documents->folderId($this->uid(), $path)];
		});
	}

	#[NoAdminRequired]
	public function makeFolder(): JSONResponse {
		return $this->run(function () {
			$path = (string)($this->request->getParam('path') ?? '');
			return ['folder' => $this->documents->makeFolder($this->uid(), $path)];
		});
	}

	#[NoAdminRequired]
	public function deleteFolder(): JSONResponse {
		return $this->run(function () {
			$path = (string)($this->request->getParam('path') ?? '');
			$this->documents->deleteFolder($this->uid(), $path);
			return ['deleted' => $path];
		});
	}

	#[NoAdminRequired]
	public function moveDocument(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$path = (string)($this->request->getParam('folder') ?? '');
			return $this->documents->move($this->uid(), $id, $path);
		});
	}

	#[NoAdminRequired]
	public function documentShares(int $id): JSONResponse {
		return $this->run(fn () => ['shares' => $this->sharing->listShares($this->uid(), $id)]);
	}

	#[NoAdminRequired]
	public function shareDocument(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$with = (string)($this->request->getParam('with') ?? '');
			$canEdit = (bool)($this->request->getParam('canEdit') ?? false);
			return ['shares' => $this->sharing->share($this->uid(), $id, $with, $canEdit)];
		});
	}

	#[NoAdminRequired]
	public function unshareDocument(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$share = (string)($this->request->getParam('share') ?? '');
			return ['shares' => $this->sharing->unshare($this->uid(), $id, $share)];
		});
	}

	#[NoAdminRequired]
	public function findUsers(): JSONResponse {
		return $this->run(function () {
			$term = (string)($this->request->getParam('term') ?? '');
			return ['users' => $this->sharing->findUsers($this->uid(), $term)];
		});
	}

	#[NoAdminRequired]
	public function createDocument(): JSONResponse {
		return $this->run(function () {
			$name = (string)($this->request->getParam('name') ?? 'Document');
			$content = (string)($this->request->getParam('content') ?? '');
			$folder = (string)($this->request->getParam('folder') ?? '');
			$folderId = (int)($this->request->getParam('folderId') ?? 0);
			return $this->documents->create($this->uid(), $name, $content, $folder, $folderId);
		});
	}

	#[NoAdminRequired]
	public function saveDocument(int $id): JSONResponse {
		return $this->run(function () use ($id) {
			$content = $this->request->getParam('content');
			if (!is_string($content)) {
				throw new \InvalidArgumentException('content missing');
			}
			$etag = (string)($this->request->getParam('etag') ?? '');
			$manual = (bool)($this->request->getParam('manual') ?? false);
			return $this->documents->save($this->uid(), $id, $content, $etag, $manual);
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

	/**
	 * The whole Unicode emoji set for the picker, with the CLDR names and keywords
	 * in the user's own language so it can be searched in Japanese as well as in
	 * English. Fetched only when the picker is first opened -- it is ~150 KB.
	 */
	#[NoAdminRequired]
	public function getEmoji(string $lang = 'auto'): JSONResponse {
		if (!in_array($lang, $this->languageCodes(), true)) {
			$lang = substr($this->l10nFactory->findLanguage(Application::APP_ID), 0, 2);
		}
		$base = realpath(__DIR__ . '/../../data/emoji');
		if ($base === false) {
			return new JSONResponse(['message' => 'no emoji data'], Http::STATUS_NOT_FOUND);
		}
		$names = realpath($base . '/' . $lang . '.json');
		if ($names === false || strpos($names, $base) !== 0) {
			$names = $base . '/en.json';
		}
		$list = json_decode((string)file_get_contents($base . '/list.json'), true);
		return new JSONResponse([
			'version' => $list['version'] ?? '',
			'groups' => $list['groups'] ?? [],
			'names' => json_decode((string)file_get_contents($names), true) ?: [],
		]);
	}

	/** @return array<int, string> */
	private function languageCodes(): array {
		return array_map(static fn (array $l): string => $l['code'], $this->availableLanguages());
	}
}
