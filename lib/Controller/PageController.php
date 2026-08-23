<?php

declare(strict_types=1);

namespace OCA\EditBase\Controller;

use OCA\EditBase\AppInfo\Application;
use OCP\App\IAppManager;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;
use OCP\L10N\IFactory;
use OCP\Util;

class PageController extends Controller {
	public function __construct(
		IRequest $request,
		private IAppManager $appManager,
		private IConfig $config,
		private IUserSession $userSession,
		private IFactory $l10nFactory,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function index(): TemplateResponse {
		Util::addStyle(Application::APP_ID, 'editbase');
		// Runtime-only Vue + precompiled render function (no template compiler → no eval).
		Util::addScript(Application::APP_ID, 'vue.runtime.global.prod');
		Util::addScript(Application::APP_ID, 'vue-private');
		Util::addScript(Application::APP_ID, 'editbase.dist');

		$user = $this->userSession->getUser();
		$uid = $user?->getUID() ?? '';
		$lang = $uid !== '' ? $this->config->getUserValue($uid, Application::APP_ID, 'language', 'auto') : 'auto';
		$l = $this->l10nFactory->get(Application::APP_ID, $lang === 'auto' ? null : $lang);

		// Resolve the theme here rather than in JS, so a reload paints the right
		// background immediately instead of flashing white on the way to dark.
		$pref = $uid !== '' ? $this->config->getUserValue($uid, Application::APP_ID, 'theme', 'auto') : 'auto';
		if (!in_array($pref, ['auto', 'light', 'dark'], true)) {
			$pref = 'auto';
		}
		$resolved = $pref === 'auto' ? $this->nextcloudTheme($uid) : $pref;

		return new TemplateResponse(Application::APP_ID, 'main', [
			'version' => $this->appManager->getAppVersion(Application::APP_ID),
			'loading' => $l->t('Loading…'),
			'theme' => $pref,
			// '' = Nextcloud is following the OS, so leave it to the CSS media query.
			'ebtheme' => $resolved,
			'fileId' => (int)($this->request->getParam('fileId', 0)),
		]);
	}

	/**
	 * Which theme Nextcloud itself is set to, when the user has chosen one.
	 * Nextcloud's dark mode is a theme app, not a media query, so this is a
	 * config lookup — and an empty list means "follow the device", which only
	 * the browser can answer.
	 */
	private function nextcloudTheme(string $uid): string {
		if ($uid === '') {
			return '';
		}
		$enabled = json_decode($this->config->getUserValue($uid, 'theming', 'enabled-themes', '[]'), true);
		if (!is_array($enabled)) {
			return '';
		}
		if (in_array('dark', $enabled, true) || in_array('dark-highcontrast', $enabled, true)) {
			return 'dark';
		}
		if (in_array('light', $enabled, true) || in_array('light-highcontrast', $enabled, true)) {
			return 'light';
		}
		return '';
	}
}
