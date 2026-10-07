<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCP\Files\File;
use OCP\ICache;
use OCP\ICacheFactory;

/**
 * Whether a document holds anything EditBase would have to take out to open it.
 *
 * The list of documents marks those files (⚠, greyed), so the writer can see
 * before opening one that it was not made here -- the owner, 2026-09-21: read
 * the files when EditBase is opened, and mark the ones it does not handle.
 * Opening one then asks first (the editor's own check, which is the same rule).
 *
 * The rule has to be exactly the editor's sanitiseInto, or the list would mark a
 * file the editor opens without a word, or the other way round. The two lists
 * of tags below are copies of HTML_TAGS and MATHML_TAGS in js/editbase.js, and
 * a test compares them with the originals (editbase-tests/php/tags-drift.php).
 *
 * A file is read once for each version of it: the answer is kept against the
 * file's id and etag, and a file that has not changed is not read again.
 */
class DocumentCheck {
	/** @var list<string> the same as HTML_TAGS in js/editbase.js, in lower case */
	public const HTML_TAGS = ['p', 'br', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark', 'code', 'pre', 'sub', 'sup', 'small', 'a',
		'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
		'img', 'figure', 'figcaption', 'div', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'dl', 'dt', 'dd', 'ruby', 'rt', 'rp', 'wbr', 'abbr', 'time', 'bdi', 'bdo'];
	/** @var list<string> the same as MATHML_TAGS in js/editbase.js */
	public const MATHML_TAGS = ['math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder',
		'munderover', 'mmultiscripts', 'mprescripts', 'mstyle', 'mpadded', 'mphantom', 'merror', 'menclose', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'maction', 'semantics', 'annotation', 'annotation-xml'];

	/**
	 * Every version of the program EditBase writes into a document when "Use
	 * JavaScript" is on, by SHA-256 of its text -- the same list as
	 * DOC_SCRIPT_SHA256 in js/editbase.js (editbase-tests/php/script-drift.php
	 * compares them). A <script id="eb-script"> whose text is one of these is
	 * EditBase's own and is not something to be removed; any other script is.
	 *
	 * @var list<string>
	 */
	public const DOC_SCRIPT_SHA256 = [
		'ce2ded243f9d2efe5ae25cbadf75a0d7a5233b124b0522a48a017a98d683ce69',
		'aea48c41b63f7d337bd6c9cfae017dd81bee566e34ebbf97737a02200b2b72a9',
		'2b63d99bb7595aadd5221aeee5611ef043b5e48b91e431b7fdf60b6e3fa4bdc3',
		'35754528deb554f52796fe5618b268705d92d45451d96c082d98cc0fdeced96b',
	];

	/** Bigger than this is not read for the list: the editor still asks when it is opened. */
	private const MAX_BYTES = 16 * 1024 * 1024;

	/**
	 * What one listing reads, at most, of files it has not checked before (review
	 * S14). Every folder somebody shares is walked for the list, and a folder of
	 * large pages shared with somebody made every opening of their list read all of
	 * it. What is left over is checked by the listings after, a share at a time,
	 * since what has been read is remembered; until then a file is shown unmarked,
	 * as a file too large to read always has been, and the editor still asks about
	 * it when it is opened.
	 */
	private const LISTING_BYTES = 32 * 1024 * 1024;
	private const LISTING_FILES = 200;

	private ?ICache $cache = null;
	private int $readBytes = 0;
	private int $readFiles = 0;

	public function __construct(ICacheFactory $caches) {
		try {
			$this->cache = $caches->createDistributed('editbase-check');
		} catch (\Throwable) {
			$this->cache = null;
		}
	}

	/**
	 * What would be taken out of this file (null if nothing would), and whether it
	 * carries EditBase's own program.
	 *
	 * @return array{found: array{count: int, tags: list<string>}|null, script: bool}
	 */
	public function forFile(File $file): array {
		$key = 'v2:' . $file->getId() . ':' . $file->getEtag();
		if ($this->cache !== null) {
			$hit = $this->cache->get($key);
			if (is_array($hit) && array_key_exists('found', $hit)) {
				return ['found' => $hit['found'], 'script' => !empty($hit['script'])];
			}
		}
		$out = ['found' => null, 'script' => false];
		try {
			$size = $file->getSize();
			if ($size <= self::MAX_BYTES) {
				if ($this->readFiles >= self::LISTING_FILES || $this->readBytes + $size > self::LISTING_BYTES) {
					// Over what this listing may read: not remembered, so a later one reads it.
					return $out;
				}
				$this->readFiles++;
				$this->readBytes += $size;
				$out = self::analyse(TextEncoding::htmlToUtf8((string)$file->getContent())['text']);
			}
		} catch (\Throwable) {
			$out = ['found' => null, 'script' => false];
		}
		if ($this->cache !== null) {
			$this->cache->set($key, $out, 7 * 24 * 3600);
		}
		return $out;
	}

	/** A listing begins: it may read as much as LISTING_BYTES again. */
	public function beginListing(): void {
		$this->readBytes = 0;
		$this->readFiles = 0;
	}

	/**
	 * Whether a <script> is EditBase's own program: named eb-script, and its text
	 * one of DOC_SCRIPT_SHA256. The same judgement as analyse() makes.
	 */
	public static function isOwnScript(string $attributes, string $text): bool {
		if (!preg_match('/(^|\s)id\s*=\s*(?:"eb-script"|\'eb-script\'|eb-script(?=[\s\/>]|$))/i', $attributes)) {
			return false;
		}
		return in_array(hash('sha256', trim($text)), self::DOC_SCRIPT_SHA256, true);
	}

	/**
	 * A document shown as a web page under Nextcloud's content security policy:
	 * EditBase's own program (isOwnScript) is given the page's nonce so that it
	 * runs; every other script in the file is taken out. The preview used to give
	 * the nonce to every script in the file, so a script somebody had written into
	 * a shared document ran in the reader's session (review 2026-10-04, 高1).
	 *
	 * The text is read the way a browser reads tags, not with one pattern over the
	 * whole of it: "<script" inside an attribute value (title="<script>") is not a
	 * tag and was being rewritten (低5), and the text of a <style>, <textarea>,
	 * <title> or <xmp> is not markup either. Everything but the scripts is handed
	 * back byte for byte.
	 */
	public static function nonceOwnScript(string $html, string $nonce): string {
		$out = '';
		$len = strlen($html);
		$i = 0;
		$raw = ['style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'];
		while ($i < $len) {
			$lt = strpos($html, '<', $i);
			if ($lt === false) {
				$out .= substr($html, $i);
				break;
			}
			$out .= substr($html, $i, $lt - $i);
			$i = $lt;
			if (substr($html, $i, 4) === '<!--') {
				// A comment runs to its "-->", whatever is inside it.
				$end = strpos($html, '-->', $i + 4);
				$stop = $end === false ? $len : $end + 3;
				$out .= substr($html, $i, $stop - $i);
				$i = $stop;
				continue;
			}
			if (!preg_match('/\G<(\/?)([a-zA-Z][^\s\/>]*)/', $html, $m, 0, $i)) {
				// "<" that begins no tag (a doctype, a lone "<"): copied as it stands.
				if (preg_match('/\G<[!?][^>]*>?/', $html, $mm, 0, $i)) {
					$out .= $mm[0];
					$i += strlen($mm[0]);
				} else {
					$out .= '<';
					$i++;
				}
				continue;
			}
			$tagEnd = self::tagEnd($html, $i + strlen($m[0]));
			$name = strtolower($m[2]);
			if ($m[1] === '/' || ($name !== 'script' && !in_array($name, $raw, true))) {
				$out .= substr($html, $i, $tagEnd - $i);
				$i = $tagEnd;
				continue;
			}
			if ($name === 'plaintext') {
				$out .= substr($html, $i);
				break;
			}
			// A raw text element: its text ends only at its own end tag.
			$close = preg_match('/<\/' . $name . '(?=[\s\/>])/i', $html, $cm, PREG_OFFSET_CAPTURE, $tagEnd) ? (int)$cm[0][1] : $len;
			if ($name !== 'script') {
				$out .= substr($html, $i, $close - $i);
				$i = $close;
				continue;
			}
			$attrEnd = $tagEnd > 0 && $html[$tagEnd - 1] === '>' ? $tagEnd - 1 : $tagEnd;
			$attributes = substr($html, $i + strlen($m[0]), $attrEnd - $i - strlen($m[0]));
			$text = substr($html, $tagEnd, $close - $tagEnd);
			$after = $close >= $len ? $len : self::tagEnd($html, $close + 2 + strlen($name));
			if (self::isOwnScript($attributes, $text)) {
				// Ours: given the nonce. Put first, so that it is the one a browser
				// keeps should the file carry a nonce of its own (the first wins).
				$out .= '<script nonce="' . htmlspecialchars($nonce, ENT_QUOTES) . '"' . $attributes . '>' . $text . substr($html, $close, $after - $close);
			}
			$i = $after;
		}
		return $out;
	}

	/**
	 * Where the tag whose name ends at $from ends: just after its ">". Read as the
	 * HTML tokenizer reads attributes: a quote counts only where a value begins
	 * (after "="), so <p "><script> is a paragraph and then a script, as it is to
	 * a browser, and not a quoted value that hides the script.
	 */
	private static function tagEnd(string $html, int $from): int {
		$len = strlen($html);
		$space = static fn (string $c): bool => $c === ' ' || $c === "\t" || $c === "\n" || $c === "\r" || $c === "\f";
		$k = $from;
		while ($k < $len) {
			$ch = $html[$k];
			if ($ch === '>') {
				return $k + 1;
			}
			if ($space($ch) || $ch === '/') {
				$k++;
				continue;
			}
			// An attribute name: its first character whatever it is, then up to a
			// space, "/", ">" or "=".
			$k++;
			while ($k < $len && !$space($html[$k]) && $html[$k] !== '/' && $html[$k] !== '>' && $html[$k] !== '=') {
				$k++;
			}
			while ($k < $len && $space($html[$k])) {
				$k++;
			}
			if ($k < $len && $html[$k] === '=') {
				$k++;
				while ($k < $len && $space($html[$k])) {
					$k++;
				}
				if ($k >= $len) {
					break;
				}
				$q = $html[$k];
				if ($q === '"' || $q === "'") {
					$end = strpos($html, $q, $k + 1);
					$k = $end === false ? $len : $end + 1;
				} else {
					while ($k < $len && !$space($html[$k]) && $html[$k] !== '>') {
						$k++;
					}
				}
			}
		}
		return $len;
	}

	/**
	 * Whether an address would run as a script when followed. A browser drops tabs
	 * and line breaks anywhere in an address, and control characters and spaces
	 * before it, so "java&#9;script:" and "&#1;javascript:" are javascript: to it
	 * (review S12); the entities themselves are already undone by the parser. The
	 * same reading as unsafeUrl() in js/editbase.js, so the list and the editor agree.
	 */
	public static function runsScript(string $url): bool {
		$url = ltrim(str_replace(["\t", "\n", "\r"], '', $url), "\x00..\x20");
		return (bool)preg_match('/^(javascript|data:text\/html|vbscript)/i', $url);
	}

	/**
	 * The same judgement as the editor's, on the text of an HTML file.
	 *
	 * @return array{count: int, tags: list<string>}|null
	 */
	public static function inHtml(string $html): ?array {
		return self::analyse($html)['found'];
	}

	/**
	 * @return array{found: array{count: int, tags: list<string>}|null, script: bool}
	 */
	public static function analyse(string $html): array {
		if (trim($html) === '') {
			return ['found' => null, 'script' => false];
		}
		// A control character written as an entity (&#1;) makes libxml drop the whole
		// attribute; a browser keeps the character, and ignores it in front of an
		// address -- so "&#1;javascript:" is a script link to it (S12). Here it is read
		// as the space it amounts to there. Only for this judgement: the file is untouched.
		$html = preg_replace('/&#(?:0*(?:[1-8]|1[1-2]|1[4-9]|2[0-9]|3[01])(?![0-9])|x0*(?:[1-8bcef]|1[0-9a-f])(?![0-9a-f]));?/i', ' ', $html) ?? $html;
		$dom = new \DOMDocument();
		$was = libxml_use_internal_errors(true);
		// The encoding declaration tells libxml the text is UTF-8; it would otherwise
		// read it as Latin-1 and see a different document.
		$dom->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
		libxml_clear_errors();
		libxml_use_internal_errors($was);
		$allowed = array_flip(array_merge(self::HTML_TAGS, self::MATHML_TAGS));
		$tags = [];
		$count = 0;
		$note = static function (string $name) use (&$tags, &$count): void {
			$tags[$name] = true;
			$count++;
		};
		// The head: a script, or a style sheet that is not our own. Our own are the
		// base sheet (#eb-base) and the writer's own rules (#eb-css); a file saved
		// before the base sheet had a name carries it as the one plain <style>, and
		// only a file that says it was made by EditBase is given that allowance.
		$ours = false;
		foreach ($dom->getElementsByTagName('meta') as $meta) {
			if (strtolower($meta->getAttribute('name')) === 'generator'
				&& preg_match('/^EditBase\b/', $meta->getAttribute('content'))) {
				$ours = true;
			}
		}
		$plain = $ours ? 1 : 0;
		$ownScript = false;
		foreach ($dom->getElementsByTagName('head') as $head) {
			foreach ($head->getElementsByTagName('script') as $sc) {
				// EditBase's own program: known by its fingerprint, not by its name.
				if ($sc->getAttribute('id') === 'eb-script'
					&& in_array(hash('sha256', trim($sc->textContent)), self::DOC_SCRIPT_SHA256, true)) {
					$ownScript = true;
					continue;
				}
				$note('script');
			}
			foreach ($head->getElementsByTagName('style') as $style) {
				$id = $style->getAttribute('id');
				if ($id === 'eb-base' || $id === 'eb-css') {
					continue;
				}
				if ($id === '' && $plain > 0) {
					$plain--;
					continue;
				}
				$note('style');
			}
		}
		$body = $dom->getElementsByTagName('body')->item(0);
		if ($body === null) {
			return ['found' => $count ? ['count' => $count, 'tags' => array_keys($tags)] : null, 'script' => $ownScript];
		}
		$walk = static function (\DOMNode $node) use (&$walk, $allowed, $note): void {
			foreach ($node->childNodes as $el) {
				if (!($el instanceof \DOMElement)) {
					continue;
				}
				$name = strtolower($el->localName ?? $el->nodeName);
				if (!isset($allowed[$name])) {
					// A frame inside one of our own embed boxes is ours.
					$parent = $el->parentNode;
					$ours = $parent instanceof \DOMElement
						&& preg_match('/(^|\s)eb-embed(\s|$)/', $parent->getAttribute('class'));
					if (!$ours) {
						$note($name);
					}
				} else {
					foreach ($el->attributes ?? [] as $attr) {
						$an = strtolower($attr->nodeName);
						if (str_starts_with($an, 'on')) {
							$note('script');
						} elseif (($an === 'href' || $an === 'src') && self::runsScript($attr->nodeValue ?? '')) {
							$note('script');
						}
					}
				}
				$walk($el);
			}
		};
		$walk($body);
		if ($count === 0) {
			return ['found' => null, 'script' => $ownScript];
		}
		$names = array_keys($tags);
		sort($names);
		return ['found' => ['count' => $count, 'tags' => $names], 'script' => $ownScript];
	}
}
