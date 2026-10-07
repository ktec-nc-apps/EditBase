<?php

declare(strict_types=1);

namespace OCA\EditBase\Settings;

use OCA\EditBase\Service\AiService;
use OCP\App\IAppManager;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IGroupManager;
use OCP\Settings\ISettings;
use OCP\Util;

/**
 * The AI assistant's settings: on or off, who may use it, what it may read and
 * whether it may search the web. Without AI-Hub it is all shown greyed out.
 */
class AiAdmin implements ISettings {
	public function __construct(
		private AiService $ai,
		private IAppManager $apps,
		private IGroupManager $groups,
	) {
	}

	public function getForm(): TemplateResponse {
		Util::addScript('editbase', 'admin-ai');
		Util::addStyle('editbase', 'admin-ai');
		$groups = [];
		foreach ($this->groups->search('') as $g) {
			$groups[] = ['id' => $g->getGID(), 'name' => $g->getDisplayName()];
		}
		$apps = [];
		foreach (AiService::SOURCES as $app) {
			$apps[$app] = $app === 'editbase' || $this->apps->isEnabledForUser($app);
		}
		return new TemplateResponse('editbase', 'admin-ai', [
			'hub' => $this->ai->hubStatus(),
			'settings' => $this->ai->settings(),
			'groups' => $groups,
			'apps' => $apps,
		], '');
	}

	public function getSection(): string {
		return 'editbase';
	}

	public function getPriority(): int {
		return 10;
	}
}
