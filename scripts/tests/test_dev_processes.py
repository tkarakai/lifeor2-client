"""Run with: python3 -m unittest discover -s scripts/tests -v.

Real disposable processes and checkouts exercise ownership without touching
running development services or Convex databases.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('dev_processes', SCRIPTS / 'dev-processes.py')
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class ProcessIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dev process isolation ')
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'client'
        self.foreign = self.base / 'client-other'  # Prefix matches must not count.
        self.processes = []
        self.install(self.root)
        self.foreign.mkdir()

    def install(self, root):
        (root / 'scripts').mkdir(parents=True)
        for name in ['dev-processes.py', 'dev-start.sh', 'dev-stop.sh',
                     'dev-stop-convex.sh', 'dev-nuke-all.sh', 'dev-status.sh']:
            shutil.copy2(SCRIPTS / name, root / 'scripts' / name)

    def tearDown(self):
        # Stop recorded descendants even if a fixture launcher failed early.
        try:
            manager.stop(self.root)
        except (ValueError, RuntimeError):
            pass
        for proc in reversed(self.processes):
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=5)
        self.temp.cleanup()

    def spawn(self, directory, source=None):
        command = ['bash', '-c', 'exec -a convex-local-backend sleep 300']
        if source is not None:
            command = [sys.executable, '-c', source]
        proc = subprocess.Popen(command, cwd=directory, start_new_session=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append(proc)
        return proc

    def run_script(self, name, *args, root=None):
        return subprocess.run(['bash', str((root or self.root) / 'scripts' / name), *args],
                              capture_output=True, text=True, timeout=15)

    def track(self, name, proc, root=None):
        root = root or self.root
        manager.track(root, name, proc.pid)
        with (root / '.dev-pids').open('a') as out:
            out.write(f'{name}:{proc.pid}\n')

    def wait_for(self, check):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if check():
                return
            time.sleep(.05)
        self.fail('Timed out waiting for disposable process')

    def test_stop_owned_tree_preserves_unrelated_backend(self):
        outsider = self.spawn(self.foreign)
        parent = self.spawn(self.root, "import subprocess,time,pathlib; "
                            "p=subprocess.Popen(['sleep','300']); "
                            "pathlib.Path('child.pid').write_text(str(p.pid)); time.sleep(300)")
        self.track('convex', parent)
        self.wait_for(lambda: (self.root / 'child.pid').exists())
        child = int((self.root / 'child.pid').read_text())
        result = self.run_script('dev-stop.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_for(lambda: parent.poll() is not None)
        self.wait_for(lambda: not manager.identity(child))
        self.assertIsNone(outsider.poll())

    def test_convex_only_stop_preserves_next_and_foreign_backend(self):
        convex = self.spawn(self.root)
        web = self.spawn(self.root)
        outsider = self.spawn(self.foreign)
        self.track('convex', convex)
        self.track('next-web', web)
        result = self.run_script('dev-stop-convex.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_for(lambda: convex.poll() is not None)
        self.assertIsNone(web.poll())
        self.assertIsNone(outsider.poll())
        self.assertEqual((self.root / '.dev-pids').read_text(), f'next-web:{web.pid}\n')
        self.assertEqual(set(manager.read_records(self.root)), {'next-web'})

    def test_stale_identity_and_foreign_pid_are_never_signalled(self):
        local = self.spawn(self.root)
        outsider = self.spawn(self.foreign)
        manager.write_records(self.root, {
            'convex': {'pid': outsider.pid, 'started': manager.identity(outsider.pid)},
            'next-web': {'pid': local.pid, 'started': 'old process start identity'},
        })
        result = self.run_script('dev-stop.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(local.poll())
        self.assertIsNone(outsider.poll())

    def test_legacy_pid_without_identity_is_not_authority(self):
        outsider = self.spawn(self.foreign)
        (self.root / '.dev-pids').write_text(f'convex:{outsider.pid}\n')
        result = self.run_script('dev-stop.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Ignoring legacy', result.stdout)
        self.assertIsNone(outsider.poll())

    def test_copied_records_fail_closed(self):
        owned = self.spawn(self.root)
        self.track('convex', owned)
        data = json.loads((self.root / '.dev-processes.json').read_text())
        data['root'] = str(self.foreign)
        (self.root / '.dev-processes.json').write_text(json.dumps(data))
        result = self.run_script('dev-stop.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(owned.poll())

    def test_noninteractive_start_restart_and_exit_preserve_foreign_backend(self):
        outsider = self.spawn(self.foreign)
        previous = self.spawn(self.root)
        self.track('next-storybook', previous)
        (self.root / 'apps/storybook').mkdir(parents=True)
        (self.root / 'scripts/copy-shared-assets.sh').write_text('#!/bin/bash\nexit 0\n')
        (self.root / 'scripts/copy-shared-assets.sh').chmod(0o755)
        bindir = self.root / 'fake-bin'
        bindir.mkdir()
        for name, content in {
            'bun': '#!/bin/sh\necho 1.3.9\n',
            'bunx': '#!/usr/bin/env python3\nimport time\nprint("Local: http://localhost:3999", flush=True)\nprint("Ready in 1ms", flush=True)\ntime.sleep(300)\n',
        }.items():
            (bindir / name).write_text(content)
            (bindir / name).chmod(0o755)
        with (self.root / 'start.log').open('w') as log:
            launcher = subprocess.Popen(
                ['bash', str(self.root / 'scripts/dev-start.sh'), '--ci', '--app=storybook'],
                cwd=self.root, env={**os.environ, 'PATH': str(bindir) + os.pathsep + os.environ['PATH']},
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
            )
            self.processes.append(launcher)
            def ready():
                return '[CI MODE] Staying in foreground' in (self.root / 'start.log').read_text()
            self.wait_for(ready)
            self.assertIsNotNone(previous.poll())
            self.assertIsNone(outsider.poll())
            launcher.terminate()
            launcher.wait(timeout=12)
        self.assertIsNone(outsider.poll())
        self.assertFalse(manager.read_records(self.root))

    def test_nuke_is_limited_to_registered_git_worktrees_and_preserves_state(self):
        def git(*args):
            subprocess.run(['git', '-C', str(self.root), *args], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        git('init')
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
            'commit', '--allow-empty', '-m', 'Fixture')
        worktree = self.base / 'second worktree'
        git('worktree', 'add', '--detach', str(worktree))
        first = self.spawn(self.root)
        second = self.spawn(worktree)
        outsider = self.spawn(self.foreign)
        self.track('convex', first)
        self.track('convex', second, root=worktree)
        state = self.root / '.convex/standalone/database'
        state.parent.mkdir(parents=True)
        state.write_text('keep my data')
        result = self.run_script('dev-nuke-all.sh', '--yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_for(lambda: first.poll() is not None and second.poll() is not None)
        self.assertIsNone(outsider.poll())
        self.assertEqual(state.read_text(), 'keep my data')


if __name__ == '__main__':
    unittest.main()
