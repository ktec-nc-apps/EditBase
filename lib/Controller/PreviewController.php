<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 KTEC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\EditBase\Controller;

use OCA\EditBase\Service\DocumentCheck;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\DataDisplayResponse;
use OCP\AppFramework\Http\Response;
use OCP\IRequest;
use OCP\IUserSession;
use OC\Security\CSP\ContentSecurityPolicyNonceManager;

/**
 * The web preview (owner 2026-09-29, BUGS #16): the saved document shown as a web
 * page, as a browser opening the file would show it -- its own program running,
 * so what the program does (the enlarging of photographs) can be seen.
 *
 * Nextcloud's pages allow no script without its nonce, so the document's own
 * program -- EditBase's, known by its fingerprint -- is given it; any other
 * script in the file is taken out, and nothing else in the file is changed.
 *
 * Only what the editor posts is shown. A GET of the saved file by its id used to
 * be shown too, with the nonce given to every script in it: a script written into
 * a shared .html ran in whoever followed the link (review 2026-10-04, 高1).
 */
class PreviewController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private IUserSession $userSession,
		private ContentSecurityPolicyNonceManager $nonces,
	) {
		parent::__construct($appName, $request);
	}

	/**
	 * The document as the editor would save it at this moment (posted by the editor),
	 * shown the same way. A file saved by an older version is shown as it will be
	 * saved now, with its pages, and nothing is written (owner 2026-09-29, BUGS #298).
	 */
	#[NoAdminRequired]
	public function posted(): Response {
		if ($this->userSession->getUser() === null) {
			return new DataDisplayResponse('', Http::STATUS_FORBIDDEN);
		}
		$html = (string)$this->request->getParam('html', '');
		if ($html === '' || strlen($html) > 40 * 1024 * 1024) {
			return new DataDisplayResponse('', Http::STATUS_BAD_REQUEST);
		}
		return $this->page($html);
	}

	private function page(string $html): Response {
		$html = DocumentCheck::nonceOwnScript($html, $this->nonces->getNonce());
		$response = new DataDisplayResponse($html, Http::STATUS_OK, ['Content-Type' => 'text/html; charset=utf-8']);
		$csp = new ContentSecurityPolicy();
		$csp->addAllowedStyleDomain('https://fonts.googleapis.com');
		$csp->addAllowedFontDomain('https://fonts.gstatic.com');
		$csp->addAllowedImageDomain('https:');
		$csp->addAllowedMediaDomain('https:');
		$csp->addAllowedFrameDomain('https:');
		$response->setContentSecurityPolicy($csp);
		return $response;
	}
}
