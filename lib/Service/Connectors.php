<?php

declare(strict_types=1);

namespace OCA\EditBase\Service;

use OCP\App\IAppManager;
use OCP\Calendar\IManager as ICalendarManager;
use OCP\Contacts\IManager as IContactsManager;
use OCP\Server;

/**
 * Everything EditBase reads out of the other apps on this server.
 *
 * Each one is optional: the app may not be installed, and its classes may not
 * exist, so every call is guarded and every failure degrades to "this source is
 * not available" rather than breaking the editor. Calls go through the other
 * app's own service layer in-process — no HTTP, no tokens, and the other app's
 * permission checks still apply because the user id is passed to them.
 */
class Connectors {
	private const ROW_LIMIT = 2000;

	public function __construct(
		private IAppManager $appManager,
		private IContactsManager $contacts,
	) {
	}

	/** @return array<string, bool> */
	public function available(string $userId): array {
		return [
			'tables' => $this->enabled('tables', $userId) && class_exists('\OCA\Tables\Service\TableService'),
			'contacts' => $this->enabled('contacts', $userId) && $this->contacts->isEnabled(),
			// Reading events needs the CalDAV backend, not the Calendar app's interface:
			// a server without the Calendar app still has the user's calendars.
			'calendar' => $this->enabled('dav', $userId),
			'notes' => $this->enabled('notes', $userId),
			'regibase' => $this->enabled('regibase', $userId) && class_exists('\OCA\RegiBase\Service\RegiBaseService'),
			'formulabase' => $this->enabled('formulabase', $userId) && class_exists('\OCA\FormulaBase\Db\CollectionMapper'),
		];
	}

	private function enabled(string $app, string $userId): bool {
		try {
			$user = Server::get(\OCP\IUserManager::class)->get($userId);
			if ($user === null || !$this->appManager->isEnabledForUser($app, $user)) {
				return false;
			}
			// An enabled app's classes are not autoloadable until the app is loaded,
			// so class_exists() below would say no for an app that is right there.
			\OC_App::loadApp($app);
			return true;
		} catch (\Throwable $e) {
			return false;
		}
	}

	private function need(string $source, string $userId): void {
		if (empty($this->available($userId)[$source])) {
			throw new \InvalidArgumentException($source . ' is not available');
		}
	}

	// ---- Tables -----------------------------------------------------------------

	/** @return array<int, array<string, mixed>> */
	public function tables(string $userId): array {
		$this->need('tables', $userId);
		$service = Server::get(\OCA\Tables\Service\TableService::class);
		$out = [];
		foreach ($service->findAll($userId) as $table) {
			$out[] = [
				'id' => (int)$table->getId(),
				'title' => (string)$table->getTitle(),
				'emoji' => method_exists($table, 'getEmoji') ? (string)$table->getEmoji() : '',
			];
		}
		return $out;
	}

	/** One table as a header row and body rows of plain strings. @return array<string, mixed> */
	public function table(string $userId, int $id): array {
		$this->need('tables', $userId);
		$tableService = Server::get(\OCA\Tables\Service\TableService::class);
		$columnService = Server::get(\OCA\Tables\Service\ColumnService::class);
		$rowService = Server::get(\OCA\Tables\Service\RowService::class);

		$table = $tableService->find($id, false, $userId);
		$columns = $columnService->findAllByTable($id, $userId);
		$titles = [];
		$options = [];
		$order = [];
		foreach ($columns as $i => $col) {
			$colId = (int)$col->getId();
			$titles[] = (string)$col->getTitle();
			$order[$colId] = $i;
			$map = [];
			if ((string)$col->getType() === 'selection') {
				try {
					foreach ($col->getSelectionOptionsArray() as $o) {
						if (isset($o['id'])) {
							$map[(string)$o['id']] = (string)($o['label'] ?? $o['id']);
						}
					}
				} catch (\Throwable $e) { /* an unlabelled option prints as its id */ }
			}
			$options[$colId] = $map;
		}
		$rows = [];
		foreach ($rowService->findAllByTable($id, $userId) as $row) {
			$cells = array_fill(0, count($titles), '');
			foreach (($row->getData() ?? []) as $cell) {
				$colId = (int)($cell['columnId'] ?? 0);
				if (!isset($order[$colId])) {
					continue;
				}
				$cells[$order[$colId]] = $this->cellToString($cell['value'] ?? null, $options[$colId] ?? []);
			}
			$rows[] = $cells;
			if (count($rows) >= self::ROW_LIMIT) {
				break;
			}
		}
		return ['title' => (string)$table->getTitle(), 'columns' => $titles, 'rows' => $rows];
	}

	/** @param array<string, string> $options */
	private function cellToString(mixed $value, array $options): string {
		if ($value === null || $value === '') {
			return '';
		}
		if (is_bool($value)) {
			return $value ? '✓' : '';
		}
		if (is_scalar($value)) {
			$s = (string)$value;
			return $options[$s] ?? $s;
		}
		if (is_array($value)) {
			$parts = [];
			foreach ($value as $v) {
				if (is_array($v)) {
					$v = $v['label'] ?? ($v['value'] ?? ($v['title'] ?? json_encode($v, JSON_UNESCAPED_UNICODE)));
				}
				$s = (string)$v;
				$parts[] = $options[$s] ?? $s;
			}
			return implode(', ', array_filter($parts, static fn ($p) => $p !== ''));
		}
		return '';
	}

	// ---- Contacts ---------------------------------------------------------------

	/**
	 * Contacts the user can read, flattened into the fields a letter needs.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function contacts(string $userId, string $query = '', int $limit = 200): array {
		$this->need('contacts', $userId);
		$found = $this->contacts->search($query, ['FN', 'N', 'ORG', 'EMAIL', 'NICKNAME'], ['types' => true, 'limit' => $limit]);
		$out = [];
		foreach ($found as $card) {
			// Entries from the user directory are real people too; they are marked so
			// the picker can group them apart from the user's own address books.
			$fields = $this->contactFields($card);
			$fields['system'] = !empty($card['isLocalSystemBook']);
			$out[] = $fields;
			if (count($out) >= $limit) {
				break;
			}
		}
		usort($out, static fn (array $a, array $b): int => strnatcasecmp((string)$a['name'], (string)$b['name']));
		return $out;
	}

	/**
	 * @param array<string, mixed> $card
	 * @return array<string, mixed>
	 */
	private function contactFields(array $card): array {
		$first = static function (mixed $v): string {
			// vCard values arrive as a string, a list, or a list of ['type'=>…,'value'=>…]
			if (is_string($v)) {
				return $v;
			}
			if (is_array($v)) {
				$head = reset($v);
				if (is_array($head)) {
					return (string)($head['value'] ?? '');
				}
				return (string)$head;
			}
			return '';
		};
		$name = (string)($card['FN'] ?? '');
		$org = $card['ORG'] ?? '';
		$org = is_array($org) ? implode(' ', array_map('strval', $org)) : (string)$org;
		// ADR is ;-separated: po box; extended; street; locality; region; postcode; country
		$adrRaw = $card['ADR'] ?? '';
		$adr = is_array($adrRaw) ? ($adrRaw[0] ?? '') : $adrRaw;
		if (is_array($adr)) {
			$adr = $adr['value'] ?? '';
		}
		$parts = is_string($adr) ? explode(';', $adr) : [];
		$parts = array_map(static fn ($p) => trim((string)$p), array_pad($parts, 7, ''));
		$nameParts = $card['N'] ?? '';
		$nameParts = is_array($nameParts) ? ($nameParts[0] ?? '') : $nameParts;
		$n = is_string($nameParts) ? array_map('trim', array_pad(explode(';', $nameParts), 5, '')) : ['', '', '', '', ''];
		return [
			'id' => (string)($card['UID'] ?? ''),
			'name' => $name,
			'family' => $n[0] ?? '',
			'given' => $n[1] ?? '',
			'org' => $org,
			'title' => $first($card['TITLE'] ?? ''),
			'email' => $first($card['EMAIL'] ?? ''),
			'tel' => $first($card['TEL'] ?? ''),
			'postcode' => $parts[6] === '' ? ($parts[5] ?? '') : $parts[5],
			'street' => trim(($parts[2] ?? '') . ' ' . ($parts[1] ?? '')),
			'locality' => $parts[3] ?? '',
			'region' => $parts[4] ?? '',
			'country' => $parts[6] ?? '',
			'note' => $first($card['NOTE'] ?? ''),
		];
	}

	// ---- Calendar ---------------------------------------------------------------

	/** @return array<int, array<string, string>> */
	public function calendars(string $userId): array {
		$this->need('calendar', $userId);
		$manager = Server::get(ICalendarManager::class);
		$out = [];
		foreach ($manager->getCalendarsForPrincipal('principals/users/' . $userId) as $calendar) {
			$out[] = [
				'key' => (string)$calendar->getKey(),
				'uri' => method_exists($calendar, 'getUri') ? (string)$calendar->getUri() : '',
				'name' => (string)$calendar->getDisplayName(),
				'colour' => (string)($calendar->getDisplayColor() ?? ''),
			];
		}
		return $out;
	}

	/**
	 * Events in a range, flattened and sorted, ready to become a list.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function events(string $userId, string $from, string $to, string $calendarKey = ''): array {
		$this->need('calendar', $userId);
		$manager = Server::get(ICalendarManager::class);
		$start = new \DateTimeImmutable($from);
		$end = new \DateTimeImmutable($to);
		$out = [];
		foreach ($manager->getCalendarsForPrincipal('principals/users/' . $userId) as $calendar) {
			if ($calendarKey !== '' && (string)$calendar->getKey() !== $calendarKey) {
				continue;
			}
			$found = [];
			try {
				$found = $calendar->search('', [], ['timerange' => ['start' => $start, 'end' => $end]], 500);
			} catch (\Throwable $e) {
				continue;
			}
			foreach ($found as $item) {
				foreach (($item['objects'] ?? []) as $object) {
					$event = $this->eventFields($object, (string)$calendar->getDisplayName());
					if ($event !== null) {
						$out[] = $event;
					}
				}
			}
		}
		usort($out, static fn (array $a, array $b): int => strcmp((string)$a['start'], (string)$b['start']));
		return $out;
	}

	/**
	 * @param array<string, mixed> $object
	 * @return array<string, mixed>|null
	 */
	private function eventFields(array $object, string $calendarName): ?array {
		$value = static function (mixed $v): mixed {
			if (is_array($v)) {
				return reset($v);
			}
			return $v;
		};
		$startRaw = $value($object['DTSTART'] ?? null);
		if (!($startRaw instanceof \DateTimeInterface)) {
			return null;
		}
		$endRaw = $value($object['DTEND'] ?? null);
		// An all-day event carries a date with no time part; Nextcloud marks it in the
		// property parameters, and a midnight-to-midnight span means the same thing.
		$allDay = $startRaw->format('His') === '000000'
			&& (!($endRaw instanceof \DateTimeInterface) || $endRaw->format('His') === '000000');
		return [
			'summary' => (string)$value($object['SUMMARY'] ?? ''),
			'location' => (string)$value($object['LOCATION'] ?? ''),
			'description' => (string)$value($object['DESCRIPTION'] ?? ''),
			'start' => $startRaw->format('c'),
			'end' => $endRaw instanceof \DateTimeInterface ? $endRaw->format('c') : '',
			'allDay' => $allDay,
			'calendar' => $calendarName,
		];
	}

	// ---- RegiBase ---------------------------------------------------------------

	/** @return array<int, array<string, mixed>> */
	public function regibaseCollections(string $userId): array {
		$this->need('regibase', $userId);
		$service = Server::get(\OCA\RegiBase\Service\RegiBaseService::class);
		$out = [];
		foreach ($service->listCollections($userId) as $collection) {
			$out[] = [
				'id' => (int)($collection['id'] ?? 0),
				'name' => (string)($collection['name'] ?? ''),
				'icon' => (string)($collection['icon'] ?? ''),
				'count' => (int)($collection['record_count'] ?? $collection['count'] ?? 0),
			];
		}
		return $out;
	}

	/**
	 * A collection's fields and records. Secret fields are never returned: they are
	 * encrypted for the browser that holds the key, and a document is not that place.
	 *
	 * @return array<string, mixed>
	 */
	public function regibaseRecords(string $userId, int $collectionId): array {
		$this->need('regibase', $userId);
		$service = Server::get(\OCA\RegiBase\Service\RegiBaseService::class);
		$collection = $service->getCollection($userId, $collectionId);
		$fields = [];
		$skip = [];
		foreach (($collection['fields'] ?? []) as $field) {
			$key = (string)($field['key'] ?? '');
			$secret = !empty($field['secret']) || ($field['type'] ?? '') === 'password';
			if ($key === '' || $secret) {
				if ($key !== '') {
					$skip[$key] = true;
				}
				continue;
			}
			$fields[] = ['key' => $key, 'label' => (string)($field['label'] ?? $key)];
		}
		$records = [];
		foreach ($service->listRecords($userId, $collectionId, null, null) as $record) {
			$data = [];
			foreach (($record['data'] ?? []) as $key => $value) {
				if (isset($skip[$key])) {
					continue;
				}
				$data[(string)$key] = is_scalar($value) ? (string)$value : '';
			}
			$records[] = ['id' => (int)($record['id'] ?? 0), 'data' => $data];
			if (count($records) >= self::ROW_LIMIT) {
				break;
			}
		}
		return ['name' => (string)($collection['name'] ?? ''), 'fields' => $fields, 'records' => $records];
	}

	// ---- FormulaBase ------------------------------------------------------------

	/** @return array<int, array<string, mixed>> */
	public function formulaCollections(string $userId): array {
		$this->need('formulabase', $userId);
		$mapper = Server::get(\OCA\FormulaBase\Db\CollectionMapper::class);
		$out = [];
		foreach ($mapper->findAllForUser($userId) as $collection) {
			$out[] = [
				'id' => (int)$collection->getId(),
				'name' => (string)$collection->getName(),
				'icon' => method_exists($collection, 'getIcon') ? (string)$collection->getIcon() : '',
			];
		}
		return $out;
	}

	/** @return array<int, array<string, mixed>> */
	public function formulas(string $userId, int $collectionId): array {
		$this->need('formulabase', $userId);
		// findForUser throws if the collection is not this user's.
		Server::get(\OCA\FormulaBase\Db\CollectionMapper::class)->findForUser($collectionId, $userId);
		$mapper = Server::get(\OCA\FormulaBase\Db\FormulaMapper::class);
		$out = [];
		foreach ($mapper->findForCollection($collectionId) as $formula) {
			$expression = (string)$formula->getExpression();
			$out[] = [
				'id' => (int)$formula->getId(),
				'name' => (string)$formula->getName(),
				'expression' => $expression,
				'description' => (string)$formula->getDescription(),
				'unit' => (string)$formula->getResultUnit(),
				'mathml' => $this->mathml($expression, (string)$formula->getName()),
			];
		}
		return $out;
	}

	/**
	 * A FormulaBase expression as MathML, so the document holds the formula as text
	 * the browser draws — never a picture of one.
	 */
	public function mathml(string $expression, string $name = ''): string {
		if (trim($expression) === '') {
			return '';
		}
		try {
			$compiler = Server::get(\OCA\FormulaBase\Service\FormulaCompiler::class);
			$ast = $compiler->parse($expression);
		} catch (\Throwable $e) {
			return '';
		}
		$body = $this->astToMathml($ast);
		if ($name !== '') {
			$body = '<mi>' . $this->esc($name) . '</mi><mo>=</mo>' . $body;
		}
		return '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow>' . $body . '</mrow></math>';
	}

	private function esc(string $s): string {
		return htmlspecialchars($s, ENT_XML1 | ENT_QUOTES, 'UTF-8');
	}

	/** @param array<string, mixed> $node */
	private function astToMathml(array $node, int $depth = 0): string {
		if ($depth > 60) {
			return '<mi>…</mi>';
		}
		$type = (string)($node['type'] ?? '');
		if ($type === 'num') {
			return '<mn>' . $this->esc((string)($node['v'] ?? '')) . '</mn>';
		}
		if ($type === 'var' || $type === 'const') {
			return '<mi>' . $this->esc((string)($node['name'] ?? '')) . '</mi>';
		}
		if ($type === 'unary') {
			$op = (string)($node['op'] ?? '-');
			return '<mo>' . $this->esc($op === '-' ? '−' : '+') . '</mo>' . $this->astToMathml($node['arg'] ?? [], $depth + 1);
		}
		if ($type === 'bin') {
			$op = (string)($node['op'] ?? '+');
			$l = $this->astToMathml($node['l'] ?? [], $depth + 1);
			$r = $this->astToMathml($node['r'] ?? [], $depth + 1);
			if ($op === '/') {
				return '<mfrac><mrow>' . $l . '</mrow><mrow>' . $r . '</mrow></mfrac>';
			}
			if ($op === '^') {
				return '<msup><mrow>' . $l . '</mrow><mrow>' . $r . '</mrow></msup>';
			}
			$signs = ['+' => '+', '-' => '−', '*' => '×', '%' => 'mod'];
			return $l . '<mo>' . $this->esc($signs[$op] ?? $op) . '</mo>' . $r;
		}
		if ($type === 'call') {
			$name = mb_strtolower((string)($node['name'] ?? ''));
			$args = array_map(fn ($a) => $this->astToMathml(is_array($a) ? $a : [], $depth + 1), (array)($node['args'] ?? []));
			if ($name === 'sqrt' && count($args) === 1) {
				return '<msqrt><mrow>' . $args[0] . '</mrow></msqrt>';
			}
			if ($name === 'abs' && count($args) === 1) {
				return '<mrow><mo>|</mo>' . $args[0] . '<mo>|</mo></mrow>';
			}
			$inner = implode('<mo>,</mo>', $args);
			return '<mi>' . $this->esc((string)($node['name'] ?? '')) . '</mi><mo>(</mo>' . $inner . '<mo>)</mo>';
		}
		return '';
	}
}
