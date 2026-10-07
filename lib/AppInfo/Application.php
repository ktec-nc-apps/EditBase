<?php

declare(strict_types=1);

namespace OCA\EditBase\AppInfo;

use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCA\EditBase\Service\AiService;
use OCA\EditBase\Settings\FetchSettings;

class Application extends App implements IBootstrap {
	public const APP_ID = 'editbase';

	public function __construct() {
		parent::__construct(self::APP_ID);
	}

	public function register(IRegistrationContext $context): void {
		// Administration settings, Security: whether a picture or a page from the web
		// may be read from this server itself or a link-local address (WebFetch).
		$context->registerDeclarativeSettings(FetchSettings::class);
	}

	public function boot(IBootContext $context): void {
		// AI-Hub, when it is installed, is told what EditBase's assistant is -- in
		// every request, since the hub keeps scenarios in memory only and the
		// request that works out an answer is not the one that asked.
		if (class_exists('\\OCA\\AIHub\\Service\\HubService')) {
			$context->injectFn(static function (AiService $ai): void {
				$ai->registerScenario();
			});
		}
	}
}
