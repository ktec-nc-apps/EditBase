<?php
declare(strict_types=1);
?>
<div id="editbase" class="app-editbase">
	<div id="editbase-root"
		data-version="<?php p($_['version'] ?? ''); ?>"
		data-theme="<?php p($_['theme'] ?? 'auto'); ?>"
		<?php if (($_['ebtheme'] ?? '') !== '') { ?>data-ebtheme="<?php p($_['ebtheme']); ?>"<?php } ?>
		data-fileid="<?php p((string)($_['fileId'] ?? 0)); ?>">
		<div class="login-wrap"><div class="login-card">
			<div class="logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 100" width="1em" height="1em"><path fill="currentColor" fill-rule="evenodd" d="M8,0 h56 a8,8 0 0 1 8,8 v84 a8,8 0 0 1 -8,8 h-56 a8,8 0 0 1 -8,-8 v-84 a8,8 0 0 1 8,-8 z M11,7 a4,4 0 0 0 -4,4 v78 a4,4 0 0 0 4,4 h50 a4,4 0 0 0 4,-4 v-78 a4,4 0 0 0 -4,-4 z"/><path fill="currentColor" d="M18,24 h36 a3.5,3.5 0 0 1 0,7 h-36 a3.5,3.5 0 0 1 0,-7 z M18,42 h36 a3.5,3.5 0 0 1 0,7 h-36 a3.5,3.5 0 0 1 0,-7 z M18,60 h22 a3.5,3.5 0 0 1 0,7 h-22 a3.5,3.5 0 0 1 0,-7 z"/></svg></div>
			<p><?php p($_['loading'] ?? 'Loading…'); ?></p>
		</div></div>
	</div>
</div>
