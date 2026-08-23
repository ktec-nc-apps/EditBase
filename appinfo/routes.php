<?php

declare(strict_types=1);

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

		// settings & translations
		['name' => 'api#getSettings', 'url' => '/api/settings', 'verb' => 'GET'],
		['name' => 'api#saveSettings', 'url' => '/api/settings', 'verb' => 'POST'],
		['name' => 'api#getI18n', 'url' => '/api/i18n/{lang}', 'verb' => 'GET'],

		// documents (plain .html files in the user's own Files)
		['name' => 'api#documents', 'url' => '/api/documents', 'verb' => 'GET'],
		['name' => 'api#createDocument', 'url' => '/api/documents', 'verb' => 'POST'],
		['name' => 'api#getDocument', 'url' => '/api/documents/{id}', 'verb' => 'GET'],
		['name' => 'api#saveDocument', 'url' => '/api/documents/{id}', 'verb' => 'PUT'],
		['name' => 'api#deleteDocument', 'url' => '/api/documents/{id}', 'verb' => 'DELETE'],
		['name' => 'api#renameDocument', 'url' => '/api/documents/{id}/rename', 'verb' => 'POST'],
		['name' => 'api#duplicateDocument', 'url' => '/api/documents/{id}/duplicate', 'verb' => 'POST'],
	],
];
