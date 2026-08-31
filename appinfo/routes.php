<?php

declare(strict_types=1);

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

		// settings & translations
		['name' => 'api#getSettings', 'url' => '/api/settings', 'verb' => 'GET'],
		['name' => 'api#saveSettings', 'url' => '/api/settings', 'verb' => 'POST'],
		['name' => 'api#getI18n', 'url' => '/api/i18n/{lang}', 'verb' => 'GET'],
		['name' => 'api#fonts', 'url' => '/api/fonts', 'verb' => 'GET'],
		['name' => 'api#fetchPage', 'url' => '/api/fetch', 'verb' => 'GET'],

		// pictures, from the user's own Files
		['name' => 'api#browseFiles', 'url' => '/api/files/browse', 'verb' => 'GET'],
		['name' => 'api#fileImage', 'url' => '/api/files/{id}/image', 'verb' => 'GET'],

		// the other apps on this server
		['name' => 'api#sources', 'url' => '/api/sources', 'verb' => 'GET'],
		['name' => 'api#tables', 'url' => '/api/tables', 'verb' => 'GET'],
		['name' => 'api#table', 'url' => '/api/tables/{id}', 'verb' => 'GET'],
		['name' => 'api#contacts', 'url' => '/api/contacts', 'verb' => 'GET'],
		['name' => 'api#calendars', 'url' => '/api/calendars', 'verb' => 'GET'],
		['name' => 'api#events', 'url' => '/api/calendar/events', 'verb' => 'GET'],
		['name' => 'api#regibaseCollections', 'url' => '/api/regibase/collections', 'verb' => 'GET'],
		['name' => 'api#regibaseRecords', 'url' => '/api/regibase/collections/{id}', 'verb' => 'GET'],
		['name' => 'api#formulaCollections', 'url' => '/api/formulabase/collections', 'verb' => 'GET'],
		['name' => 'api#formulas', 'url' => '/api/formulabase/collections/{id}/formulas', 'verb' => 'GET'],

		// documents (plain .html files in the user's own Files)
		['name' => 'api#documents', 'url' => '/api/documents', 'verb' => 'GET'],
		['name' => 'api#createDocument', 'url' => '/api/documents', 'verb' => 'POST'],
		['name' => 'api#getDocument', 'url' => '/api/documents/{id}', 'verb' => 'GET'],
		['name' => 'api#saveDocument', 'url' => '/api/documents/{id}', 'verb' => 'PUT'],
		['name' => 'api#deleteDocument', 'url' => '/api/documents/{id}', 'verb' => 'DELETE'],
		['name' => 'api#renameDocument', 'url' => '/api/documents/{id}/rename', 'verb' => 'POST'],
		['name' => 'api#duplicateDocument', 'url' => '/api/documents/{id}/duplicate', 'verb' => 'POST'],
		['name' => 'api#moveDocument', 'url' => '/api/documents/{id}/move', 'verb' => 'POST'],
		['name' => 'api#documentState', 'url' => '/api/documents/{id}/state', 'verb' => 'GET'],
		['name' => 'api#leaveDocument', 'url' => '/api/documents/{id}/leave', 'verb' => 'POST'],

		// folders to keep them in, and sharing them with other accounts here
		['name' => 'api#folders', 'url' => '/api/folders', 'verb' => 'GET'],
		['name' => 'api#makeFolder', 'url' => '/api/folders', 'verb' => 'POST'],
		['name' => 'api#folderId', 'url' => '/api/folders/id', 'verb' => 'GET'],
		['name' => 'api#documentShares', 'url' => '/api/documents/{id}/shares', 'verb' => 'GET'],
		['name' => 'api#shareDocument', 'url' => '/api/documents/{id}/shares', 'verb' => 'POST'],
		['name' => 'api#unshareDocument', 'url' => '/api/documents/{id}/shares/remove', 'verb' => 'POST'],
		['name' => 'api#findUsers', 'url' => '/api/users', 'verb' => 'GET'],
	],
];
