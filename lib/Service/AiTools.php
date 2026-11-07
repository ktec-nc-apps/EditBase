<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCA\EditBase\AppInfo\Application;
use OCP\ICacheFactory;

/**
 * What the assistant can do with the writer's documents by itself (the owner, 2026-11-07:
 * "RegiBase の中は自由に AI が操作できるようにしろ" -- and the same for the other apps).
 *
 * The open document is changed as before, through the editbase-actions list the editor
 * carries out (one step Ctrl+Z undoes). These tools are for the other documents: list,
 * read, make, add to, find-and-replace in, rename, move and delete them. They run with
 * the writer's own rights through DocumentService, so a document shared read-only stays
 * read-only. Before a tool writes into a document, the version of what is there is kept
 * ("Versions…"), whatever the writer's version setting, so every change can be taken back;
 * a deleted document goes to the Nextcloud trash with its versions.
 *
 * A tool never writes into the document that is open in the editor: the editor holds its
 * own copy and would have to fight the change. What is open is noted when the question is
 * asked (noteOpen()), because AI-Hub answers in a request of its own.
 */
class AiTools {
	private const OPEN_TTL = 3600;
	private const OUT_MAX = 60000;
	private const WRITE_TOOLS = ['create_document', 'add_to_document', 'replace_in_document', 'rename_document', 'move_document', 'delete_document'];

	public function __construct(
		private DocumentService $docs,
		private VersionService $versions,
		private ICacheFactory $cacheFactory,
		private \OCP\L10N\IFactory $l10n,
		private \OCP\IConfig $config,
	) {
	}

	/**
	 * EditBase's words in the asker's language. AI-Hub runs the tools in a request of its own,
	 * with no one signed in, so the language is the person's own setting, not the request's.
	 */
	private function l(?string $uid): \OCP\IL10N {
		$lang = $uid !== null ? $this->config->getUserValue($uid, 'core', 'lang', '') : '';
		return $lang !== '' ? $this->l10n->get(Application::APP_ID, $lang) : $this->l10n->get(Application::APP_ID);
	}

	/** @return list<string> The tools that change something (the editor reloads its list after one). */
	public static function writeTools(): array {
		return self::WRITE_TOOLS;
	}

	private function cache(): ?\OCP\ICache {
		return $this->cacheFactory->isAvailable() ? $this->cacheFactory->createDistributed(Application::APP_ID . '_ai_open') : null;
	}

	/** Called in the writer's own request as the question is asked: which document is open. */
	public function noteOpen(string $uid, int $docId): void {
		$this->cache()?->set('doc_' . $uid, (string)$docId, self::OPEN_TTL);
	}

	private function openDoc(string $uid): int {
		return (int)($this->cache()?->get('doc_' . $uid) ?? 0);
	}

	/**
	 * @param callable(): list<string> $allowed What the administrator allows (AiService::settings()['read']).
	 */
	public function tools(callable $allowed): array {
		$wrap = function (string $need, callable $fn) use ($allowed): callable {
			return function (string $uid, array $args) use ($need, $fn, $allowed) {
				if (!in_array($need, $allowed(), true)) {
					return $need === 'write'
						? '{"error":"The administrator has not allowed the assistant to change other documents. Change the open document with editbase-actions, or tell the writer how."}'
						: '{"error":"The administrator has not allowed the assistant to read the writer\'s other documents."}';
				}
				try {
					$out = $fn($uid, $args);
				} catch (\OCP\Files\NotFoundException $e) {
					$out = ['error' => 'No such document (or the writer cannot open it).'];
				} catch (\OCP\Files\NotPermittedException $e) {
					$out = ['error' => 'The writer may not do that with this document (it is shared read only, or the folder is).'];
				} catch (\InvalidArgumentException $e) {
					$out = ['error' => $e->getMessage()];
				} catch (\RuntimeException $e) {
					$out = ['error' => $e->getMessage()];
				}
				$json = json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
				return mb_strlen($json) > self::OUT_MAX ? mb_substr($json, 0, self::OUT_MAX) . ' …(cut)' : $json;
			};
		};
		$block = ['type' => 'object'];
		return [
			'list_documents' => [
				'kind' => 'read',
				'label' => $this->l(null)->t('List documents'),
				'description' => 'The writer\'s EditBase documents (their own and those shared with them): id, name, category, last changed, whether they may write in it, and which one is open in the editor now.',
				'input' => ['type' => 'object', 'properties' => ['query' => ['type' => 'string']]],
				'run' => $wrap('editbase', fn ($uid, $a) => $this->listDocuments($uid, (string)($a['query'] ?? ''))),
			],
			'read_document' => [
				'kind' => 'read',
				'label' => $this->l(null)->t('Read a document'),
				'description' => 'The text of one document, block by block (headings, paragraphs, list items, table rows), from offset, up to 40,000 characters.',
				'input' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer'], 'offset' => ['type' => 'integer']], 'required' => ['id']],
				'run' => $wrap('editbase', fn ($uid, $a) => $this->readDocument($uid, (int)$a['id'], (int)($a['offset'] ?? 0))),
			],
			'create_document' => [
				'kind' => 'create',
				'label' => $this->l(null)->t('Make a document'),
				'description' => 'Make a new document: name, category ("" = the top of the EditBase folder), and blocks as in editbase-actions insert ({"tag":"p"|"h1"|"h2"|"h3"|"h4"|"blockquote","text":"..."}, {"tag":"ul"|"ol","items":[...]}, {"tag":"table","rows":[[...]],"header":true}, {"tag":"pagebreak"}). It takes the writer\'s default paper when opened.',
				'input' => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'category' => ['type' => 'string'],
					'blocks' => ['type' => 'array', 'items' => $block]], 'required' => ['name', 'blocks']],
				'run' => $wrap('write', fn ($uid, $a) => $this->createDocument($uid, (string)$a['name'], (string)($a['category'] ?? ''), (array)$a['blocks'])),
			],
			'add_to_document' => [
				'kind' => 'update',
				'label' => $this->l(null)->t('Add to a document'),
				'description' => 'Add blocks (as in create_document) at the end of another document. Not for the open document: use editbase-actions for that.',
				'input' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer'], 'blocks' => ['type' => 'array', 'items' => $block]], 'required' => ['id', 'blocks']],
				'run' => $wrap('write', fn ($uid, $a) => $this->addToDocument($uid, (int)$a['id'], (array)$a['blocks'])),
			],
			'replace_in_document' => [
				'kind' => 'update',
				'label' => $this->l(null)->t('Replace words in a document'),
				'description' => 'Find words and replace them in another document\'s text, keeping its formatting (all = every place, otherwise the first). Not for the open document.',
				'input' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer'], 'find' => ['type' => 'string'], 'replace' => ['type' => 'string'], 'all' => ['type' => 'boolean']], 'required' => ['id', 'find', 'replace']],
				'run' => $wrap('write', fn ($uid, $a) => $this->replaceIn($uid, (int)$a['id'], (string)$a['find'], (string)$a['replace'], !empty($a['all']))),
			],
			'rename_document' => [
				'kind' => 'update',
				'label' => $this->l(null)->t('Rename a document'),
				'description' => 'Give a document a new name.',
				'input' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer'], 'name' => ['type' => 'string']], 'required' => ['id', 'name']],
				'run' => $wrap('write', fn ($uid, $a) => $this->renamed($uid, (int)$a['id'], (string)$a['name'])),
			],
			'move_document' => [
				'kind' => 'update',
				'label' => $this->l(null)->t('Move a document'),
				'description' => 'Put a document of the writer\'s own into a category ("" = the top of the EditBase folder; a new name makes the category).',
				'input' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer'], 'category' => ['type' => 'string']], 'required' => ['id', 'category']],
				'run' => $wrap('write', fn ($uid, $a) => $this->moved($uid, (int)$a['id'], (string)$a['category'])),
			],
			'delete_document' => [
				'kind' => 'delete',
				'label' => $this->l(null)->t('Delete a document'),
				'description' => 'Delete a document (it goes to the Nextcloud trash with its versions, from where it can be brought back). Not the open document.',
				'input' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer']], 'required' => ['id']],
				'run' => $wrap('write', fn ($uid, $a) => $this->deleteDocument($uid, (int)$a['id'])),
			],
		];
	}

	private function short(array $d, bool $withCategory = false): array {
		$out = ['id' => (int)$d['id'], 'name' => self::title((string)$d['name'])];
		if ($withCategory) {
			$out['category'] = (string)$d['folder'];
		}
		return $out;
	}

	/** A document's name as the list shows it, without .html. */
	private static function title(string $name): string {
		return (string)preg_replace('/\.html?$/i', '', $name);
	}

	private function notOpen(string $uid, int $id): void {
		if ($id > 0 && $id === $this->openDoc($uid)) {
			throw new \InvalidArgumentException('That is the document open in the editor: change it with an editbase-actions block instead, so the writer sees it and can undo it with Ctrl+Z.');
		}
	}

	private function listDocuments(string $uid, string $query): array {
		$open = $this->openDoc($uid);
		$q = mb_strtolower(trim($query));
		$out = [];
		foreach ($this->docs->list($uid) as $d) {
			$name = (string)($d['name'] ?? '');
			if ($q !== '' && !str_contains(mb_strtolower($name . ' ' . ($d['folder'] ?? '')), $q)) {
				continue;
			}
			$row = ['id' => (int)$d['id'], 'name' => $name, 'category' => (string)($d['folder'] ?? ''),
				'changed' => date('Y-m-d H:i', (int)($d['mtime'] ?? 0)), 'writable' => !empty($d['writable'])];
			if (!empty($d['shared'])) {
				$row['shared_by'] = (string)($d['owner'] ?? '');
			}
			if ((int)$d['id'] === $open) {
				$row['open_in_editor'] = true;
			}
			$out[] = $row;
		}
		return ['documents' => $out];
	}

	private static function load(string $html): \DOMDocument {
		$dom = new \DOMDocument();
		libxml_use_internal_errors(true);
		$dom->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NONET | LIBXML_HTML_NODEFDTD);
		libxml_clear_errors();
		return $dom;
	}

	private function readDocument(string $uid, int $id, int $offset): array {
		$d = $this->docs->get($uid, $id);
		$dom = self::load((string)$d['content']);
		$lines = [];
		$xp = new \DOMXPath($dom);
		foreach ($xp->query('//body//*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6 or self::p or self::li or self::tr or self::blockquote or self::figcaption or self::pre]') as $el) {
			// a block inside another one is read with it
			if ($xp->query('ancestor::*[self::p or self::li or self::tr or self::pre]', $el)->length > 0) {
				continue;
			}
			$tag = strtolower($el->nodeName);
			$text = $tag === 'tr'
				? implode(' | ', array_map(fn ($c) => trim((string)preg_replace('/\s+/u', ' ', $c->textContent)), iterator_to_array($xp->query('./td|./th', $el))))
				: trim((string)preg_replace('/\s+/u', ' ', $el->textContent));
			if ($text !== '') {
				$lines[] = $tag . ': ' . $text;
			}
		}
		$all = implode("\n", $lines);
		return ['id' => $id, 'name' => (string)$d['name'], 'writable' => !empty($d['writable']), 'length' => mb_strlen($all),
			'offset' => max(0, $offset), 'text' => mb_substr($all, max(0, $offset), 40000)];
	}

	/** The blocks of editbase-actions as HTML. */
	private static function blocksHtml(array $blocks): string {
		$esc = static function (string $s): string {
			$s = htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
			$s = (string)preg_replace('/\*\*(.+?)\*\*/su', '<strong>$1</strong>', $s);
			$s = (string)preg_replace('/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/su', '<em>$1</em>', $s);
			return str_replace("\n", '<br>', $s);
		};
		$out = '';
		foreach ($blocks as $b) {
			if (!is_array($b)) {
				continue;
			}
			$tag = (string)($b['tag'] ?? 'p');
			if (in_array($tag, ['p', 'h1', 'h2', 'h3', 'h4', 'blockquote'], true)) {
				$out .= '<' . $tag . '>' . ($esc((string)($b['text'] ?? '')) ?: '<br>') . '</' . $tag . ">\n";
			} elseif ($tag === 'ul' || $tag === 'ol') {
				$out .= '<' . $tag . '>' . implode('', array_map(fn ($i) => '<li>' . $esc((string)$i) . '</li>', (array)($b['items'] ?? []))) . '</' . $tag . ">\n";
			} elseif ($tag === 'table') {
				$rows = array_values((array)($b['rows'] ?? []));
				$html = '<table>';
				foreach ($rows as $r => $cells) {
					$cell = ($r === 0 && !empty($b['header'])) ? 'th' : 'td';
					$html .= '<tr>' . implode('', array_map(fn ($c) => '<' . $cell . '>' . $esc((string)$c) . '</' . $cell . '>', (array)$cells)) . '</tr>';
				}
				$out .= $html . "</table>\n";
			} elseif ($tag === 'pagebreak') {
				$out .= '<div class="eb-pagebreak"></div>' . "\n";
			} else {
				throw new \InvalidArgumentException('Unknown block tag "' . $tag . '".');
			}
		}
		return $out;
	}

	private function createDocument(string $uid, string $name, string $category, array $blocks): array {
		$name = trim($name);
		if ($name === '') {
			throw new \InvalidArgumentException('A document needs a name.');
		}
		$body = self::blocksHtml($blocks) ?: "<p><br></p>\n";
		$title = htmlspecialchars($name, ENT_QUOTES | ENT_HTML5, 'UTF-8');
		$html = "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<title>" . $title . "</title>\n</head>\n<body class=\"eb-doc\">\n" . $body . "</body>\n</html>\n";
		$out = $this->short($this->docs->create($uid, $name, $html, $category), true);
		$out['_report'] = $category !== ''
			? $this->l($uid)->t('Made "%1$s" in "%2$s"', [$out['name'], $out['category']])
			: $this->l($uid)->t('Made "%s"', [$out['name']]);
		return $out;
	}

	/** Write $html into the document, keeping the version of what is there first. */
	private function write(string $uid, int $id, string $etag, string $html): void {
		$keep = $this->versions->keep($uid);
		if ($keep < 1) {
			// the writer keeps no versions; one is kept all the same, since the assistant wrote it
			try {
				$this->versions->take($this->fileOf($uid, $id), 1);
			} catch (\Throwable $e) {
			}
		}
		$r = $this->docs->save($uid, $id, $html, $etag, $keep > 0);
		if (!empty($r['stale'])) {
			throw new \RuntimeException('Somebody changed the document at the same moment; nothing was written. Try again.');
		}
	}

	private function fileOf(string $uid, int $id): \OCP\Files\File {
		$d = $this->docs->get($uid, $id);
		foreach (\OCP\Server::get(\OCP\Files\IRootFolder::class)->getUserFolder($uid)->getById($id) as $n) {
			if ($n instanceof \OCP\Files\File) {
				return $n;
			}
		}
		throw new \OCP\Files\NotFoundException((string)$d['name']);
	}

	/**
	 * Where blocks added at the end go: inside the last page of a document saved in pages
	 * (before that page's closing tag), or before </body>. Found in the text itself, so
	 * nothing else in the file is parsed and written out again.
	 */
	private static function endOf(string $html): int {
		$starts = [];
		if (preg_match_all('/<div class="eb-page"[^>]*>/i', $html, $m, PREG_OFFSET_CAPTURE)) {
			$starts = $m[0];
		}
		if ($starts !== []) {
			[$tag, $at] = $starts[count($starts) - 1];
			$depth = 1;
			$pos = $at + strlen($tag);
			while ($depth > 0 && preg_match('/<div\b[^>]*>|<\/div\s*>/i', $html, $mm, PREG_OFFSET_CAPTURE, $pos)) {
				$depth += str_starts_with($mm[0][0], '</') ? -1 : 1;
				if ($depth === 0) {
					return (int)$mm[0][1];
				}
				$pos = $mm[0][1] + strlen($mm[0][0]);
			}
		}
		$b = strripos($html, '</body>');
		return $b === false ? strlen($html) : $b;
	}

	private function addToDocument(string $uid, int $id, array $blocks): array {
		$this->notOpen($uid, $id);
		$d = $this->docs->get($uid, $id);
		if (empty($d['writable'])) {
			throw new \OCP\Files\NotPermittedException('read only');
		}
		$html = (string)$d['content'];
		$at = self::endOf($html);
		$html = substr($html, 0, $at) . self::blocksHtml($blocks) . substr($html, $at);
		$this->write($uid, $id, (string)$d['etag'], $html);
		return ['added' => count($blocks), 'to' => (string)$d['name'],
			'_report' => $this->l($uid)->t('Added to "%1$s" — blocks: %2$s', [self::title((string)$d['name']), (string)count($blocks)])];
	}

	/** Replace in the words of the document only: never inside a tag, a script or a style. */
	private function replaceIn(string $uid, int $id, string $find, string $replace, bool $all): array {
		$this->notOpen($uid, $id);
		if ($find === '') {
			throw new \InvalidArgumentException('Say what to find.');
		}
		$d = $this->docs->get($uid, $id);
		if (empty($d['writable'])) {
			throw new \OCP\Files\NotPermittedException('read only');
		}
		$html = (string)$d['content'];
		$f = htmlspecialchars($find, ENT_NOQUOTES | ENT_HTML5, 'UTF-8');
		$r = htmlspecialchars($replace, ENT_NOQUOTES | ENT_HTML5, 'UTF-8');
		$bodyAt = stripos($html, '<body');
		$head = $bodyAt === false ? '' : substr($html, 0, $bodyAt);
		$rest = $bodyAt === false ? $html : substr($html, $bodyAt);
		$parts = preg_split('/(<script\b.*?<\/script>|<style\b.*?<\/style>|<!--.*?-->|<[^>]*>)/is', $rest, -1, PREG_SPLIT_DELIM_CAPTURE);
		$n = 0;
		foreach ($parts as $i => $part) {
			if ($part === '' || $part[0] === '<' || !str_contains($part, $f)) {
				continue;
			}
			if ($all) {
				$n += substr_count($part, $f);
				$parts[$i] = str_replace($f, $r, $part);
			} else {
				$pos = strpos($part, $f);
				$parts[$i] = substr($part, 0, $pos) . $r . substr($part, $pos + strlen($f));
				$n = 1;
				break;
			}
		}
		if ($n === 0) {
			return ['replaced' => 0, 'note' => 'Not found as one piece of text (formatting may split it).',
				'_report' => $this->l($uid)->t('"%2$s" was not found in "%1$s"; nothing was changed', [self::title((string)$d['name']), $find])];
		}
		$this->write($uid, $id, (string)$d['etag'], $head . implode('', $parts));
		return ['replaced' => $n, 'in' => (string)$d['name'],
			'_report' => $this->l($uid)->t('Replaced "%2$s" with "%3$s" in "%1$s" — places: %4$s', [self::title((string)$d['name']), $find, $replace, (string)$n])];
	}

	private function deleteDocument(string $uid, int $id): array {
		$this->notOpen($uid, $id);
		$d = $this->docs->get($uid, $id);
		$this->docs->delete($uid, $id);
		return ['deleted' => (string)$d['name'], 'note' => 'In the Nextcloud trash with its versions.',
			'_report' => $this->l($uid)->t('Deleted "%s" (it is in the trash)', [self::title((string)$d['name'])])];
	}

	private function renamed(string $uid, int $id, string $name): array {
		$was = self::title((string)$this->docs->get($uid, $id)['name']);
		$out = $this->short($this->docs->rename($uid, $id, $name));
		$out['_report'] = $this->l($uid)->t('Renamed "%1$s" to "%2$s"', [$was, $out['name']]);
		return $out;
	}

	private function moved(string $uid, int $id, string $category): array {
		$out = $this->short($this->docs->move($uid, $id, $category), true);
		$out['_report'] = $out['category'] !== ''
			? $this->l($uid)->t('Moved "%1$s" to "%2$s"', [$out['name'], $out['category']])
			: $this->l($uid)->t('Moved "%s" to the top of the EditBase folder', [$out['name']]);
		return $out;
	}
}
