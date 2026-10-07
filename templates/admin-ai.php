<?php
/** @var array $_ */
/** @var \OCP\IL10N $l */
$tb = $_['hub'];
$s = $_['settings'];
$off = !$tb['present'];
$providers = ['claude' => 'Claude', 'gemini' => 'Gemini', 'openai' => 'OpenAI'];
$reasons = [
	'no-key' => $l->t('No API key is set in AI-Hub.'),
	'no-cli' => $l->t('AI-Hub\'s command line tool is not set up.'),
	'no-store' => $l->t('AI-Hub needs a memory cache or a writable temporary folder.'),
	'no-model' => $l->t('No model is chosen in AI-Hub.'),
];
?>
<div id="editbase-ai-admin" class="section<?php if ($off) { p(' eb-off'); } ?>"
	data-saved="<?php p($l->t('Saved.')); ?>" data-failed="<?php p($l->t('Could not save.')); ?>">
	<h2><?php p($l->t('AI assistant')); ?></h2>
	<p class="settings-hint"><?php p($l->t('EditBase asks AI-Hub for its AI: a chat at the right of the editor that knows EditBase, changes the open document when asked, and reads only what is allowed here. The key, the model and the limits are set in AI-Hub.')); ?></p>
	<?php if ($off) { ?>
		<p class="eb-ai-state warn"><?php p($l->t('AI-Hub is not installed or is switched off, so the assistant cannot be used. Install AI-Hub from the App Store to set it up here.')); ?></p>
	<?php } else { ?>
		<p class="eb-ai-state<?php if (!$tb['ready']) { p(' warn'); } ?>">
			<?php p($l->t('AI-Hub: %1$s (%2$s), model %3$s', [$providers[$tb['provider']] ?? $tb['provider'], $tb['mode'] === 'cli' ? $l->t('command line') : 'API', $tb['model'] !== '' ? $tb['model'] : '—'])); ?>
			— <?php p($tb['ready'] ? $l->t('Ready.') : ($reasons[$tb['reason']] ?? $tb['reason'])); ?>
		</p>
	<?php } ?>
	<fieldset <?php if ($off) { p('disabled'); } ?>>
		<p><input type="checkbox" class="checkbox" id="eb-ai-enabled" <?php if ($s['enabled']) { p('checked'); } ?>>
			<label for="eb-ai-enabled"><?php p($l->t('Use the AI assistant in EditBase')); ?></label></p>

		<h3><?php p($l->t('Who may use it')); ?></h3>
		<p><input type="radio" class="radio" name="eb-ai-users" id="eb-ai-users-all" value="all" <?php if ($s['users'] === 'all') { p('checked'); } ?>>
			<label for="eb-ai-users-all"><?php p($l->t('Everyone')); ?></label></p>
		<p><input type="radio" class="radio" name="eb-ai-users" id="eb-ai-users-groups" value="groups" <?php if ($s['users'] === 'groups') { p('checked'); } ?>>
			<label for="eb-ai-users-groups"><?php p($l->t('Only the members of these groups')); ?></label></p>
		<div class="eb-ai-groups">
			<?php foreach ($_['groups'] as $g) { $gid = 'eb-ai-g-' . md5($g['id']); ?>
				<p><input type="checkbox" class="checkbox" id="<?php p($gid); ?>" data-group="<?php p($g['id']); ?>" <?php if (in_array($g['id'], $s['groups'], true)) { p('checked'); } ?>>
					<label for="<?php p($gid); ?>"><?php p($g['name']); ?></label></p>
			<?php } ?>
		</div>

		<h3><?php p($l->t('What it may read (read only — it never changes anything there)')); ?></h3>
		<p class="settings-hint"><?php p($l->t('Whatever is ticked here, every question goes to the AI together with the open document: its title and paper, the first 24,000 bytes of its text paragraph by paragraph (about 24,000 letters, or 8,000 Japanese characters), and up to 2,000 characters of what is selected — a document somebody else shared with the writer too. The apps ticked here are read only when the assistant asks for them, and only what the writer may see.')); ?></p>
		<?php
		$labels = [
			'editbase' => $l->t('The writer\'s other EditBase documents'),
			'regibase' => $l->t('RegiBase (fields kept secret are never read)'),
			'formulabase' => $l->t('FormulaBase'),
			'netbase' => $l->t('NetBase (the list of devices found on the local network)'),
		];
		foreach ($labels as $app => $label) { $there = $_['apps'][$app]; ?>
			<p><input type="checkbox" class="checkbox" id="eb-ai-read-<?php p($app); ?>" data-read="<?php p($app); ?>"
				<?php if (in_array($app, $s['read'], true)) { p('checked'); } ?> <?php if (!$there) { p('disabled'); } ?>>
				<label for="eb-ai-read-<?php p($app); ?>"><?php p($label); ?><?php if (!$there) { p(' ' . $l->t('(not installed)')); } ?></label></p>
		<?php } ?>

		<h3><?php p($l->t('Web search')); ?></h3>
		<p><input type="checkbox" class="checkbox" id="eb-ai-search" <?php if ($s['search']) { p('checked'); } ?> <?php if (!$off && !$tb['search']) { p('disabled'); } ?>>
			<label for="eb-ai-search"><?php p($l->t('Let it search the web (on the AI provider\'s side: this server\'s own network is never reached)')); ?></label></p>
		<?php if (!$off && !$tb['search']) { ?>
			<p class="settings-hint"><?php p($l->t('Not available with the way AI-Hub connects to the AI.')); ?></p>
		<?php } ?>

		<p class="eb-ai-save"><button type="button" class="button primary" id="eb-ai-save"><?php p($l->t('Save')); ?></button>
			<span class="eb-ai-msg" aria-live="polite"></span></p>
	</fieldset>
</div>
