<?php

declare(strict_types=1);

namespace OCA\EditBase\Settings;

use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\Settings\IIconSection;

/** "EditBase" in the administration settings, for its AI assistant. */
class AiSection implements IIconSection {
	public function __construct(
		private IL10N $l,
		private IURLGenerator $url,
	) {
	}

	public function getID(): string {
		return 'editbase';
	}

	public function getName(): string {
		return $this->l->t('EditBase');
	}

	public function getPriority(): int {
		return 75;
	}

	public function getIcon(): string {
		return $this->url->imagePath('editbase', 'app-dark.svg');
	}
}
