// EditBase, administration settings: the AI assistant (through AI-Hub).
(function () {
	'use strict';
	function ready(fn) { if (document.readyState !== 'loading') { fn(); } else { document.addEventListener('DOMContentLoaded', fn); } }
	ready(function () {
		var root = document.getElementById('editbase-ai-admin');
		if (!root) { return; }
		var msg = root.querySelector('.eb-ai-msg');
		var groupsBox = root.querySelector('.eb-ai-groups');
		function syncGroups() {
			var only = root.querySelector('#eb-ai-users-groups');
			groupsBox.classList.toggle('dim', !(only && only.checked));
		}
		root.querySelectorAll('input[name="eb-ai-users"]').forEach(function (r) { r.addEventListener('change', syncGroups); });
		syncGroups();
		root.querySelector('#eb-ai-save').addEventListener('click', function () {
			var users = root.querySelector('input[name="eb-ai-users"]:checked');
			var body = {
				enabled: root.querySelector('#eb-ai-enabled').checked,
				users: users ? users.value : 'all',
				groups: Array.prototype.map.call(root.querySelectorAll('input[data-group]:checked'), function (x) { return x.getAttribute('data-group'); }),
				read: Array.prototype.map.call(root.querySelectorAll('input[data-read]:checked'), function (x) { return x.getAttribute('data-read'); }),
				search: root.querySelector('#eb-ai-search').checked,
			};
			msg.textContent = '';
			fetch(OC.generateUrl('/apps/editbase/api/ai/admin'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', requesttoken: OC.requestToken },
				body: JSON.stringify(body),
			}).then(function (r) {
				msg.textContent = r.ok ? root.getAttribute('data-saved') : root.getAttribute('data-failed');
			}).catch(function () { msg.textContent = root.getAttribute('data-failed'); });
		});
	});
})();
