<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 KTEC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\EditBase\Controller;

use OCA\EditBase\Service\DocumentService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
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
 * <script> elements are given it; nothing else in the file is changed.
 */
class PreviewController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private DocumentService $documents,
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

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function show(int $id): Response {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataDisplayResponse('', Http::STATUS_FORBIDDEN);
		}
		try {
			$doc = $this->documents->get($user->getUID(), $id);
		} catch (\Throwable $e) {
			return new DataDisplayResponse('', Http::STATUS_NOT_FOUND);
		}
		return $this->page((string)($doc['content'] ?? ''));
	}

	private function page(string $html): Response {
		$nonce = $this->nonces->getNonce();
		$html = (string)preg_replace('/<script\b(?![^>]*\bnonce=)/i', '<script nonce="' . htmlspecialchars($nonce, ENT_QUOTES) . '"', $html);
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
