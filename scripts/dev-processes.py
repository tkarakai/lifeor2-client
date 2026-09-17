#!/usr/bin/env python3
"""Manage only recorded development processes belonging to one checkout.

Process names and port numbers are not ownership evidence. Never discover or
kill global "orphans". The legacy .dev-pids file remains for launcher/status
compatibility; .dev-processes.json supplies the process start identities.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


def ps(pid, fields):
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", fields], capture_output=True, text=True,
        env={**os.environ, "LC_ALL": "C"},
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def identity(pid):
    if pid <= 1 or ps(pid, "stat=").startswith("Z"):
        return ""
    started = ps(pid, "lstart=")
    if not started:
        return ""
    # Linux provides a more precise identity than ps's wall-clock seconds.
    proc = Path(f"/proc/{pid}/stat")
    try:
        ticks = proc.read_text().rsplit(")", 1)[1].split()[19]
        started += ":" + ticks
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        pass
    return started


def cwd(pid):
    try:
        if Path("/proc").is_dir():
            return Path(os.readlink(f"/proc/{pid}/cwd")).resolve()
        result = subprocess.run(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            capture_output=True, text=True,
        )
        return next((Path(line[1:]).resolve() for line in result.stdout.splitlines()
                     if line.startswith("n")), None)
    except (OSError, RuntimeError):
        return None


def inside(root, directory):
    return directory is not None and (directory == root or root in directory.parents)


def ancestors():
    result = set()
    pid = os.getpid()
    while pid > 1 and pid not in result:
        result.add(pid)
        parent = ps(pid, "ppid=")
        if not parent:
            break
        pid = int(parent)
    return result


def matches(root, record):
    pid = record.get("pid", 0)
    started = record.get("started")
    return (isinstance(pid, int) and pid > 1 and bool(started)
            and identity(pid) == started and inside(root, cwd(pid)))


def read_records(root):
    path = root / ".dev-processes.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if data.get("root") != str(root) or not isinstance(data.get("services"), dict):
        raise RuntimeError("Process records belong to another checkout or are invalid; no processes stopped.")
    return data["services"]


def write_records(root, records):
    with tempfile.NamedTemporaryFile(mode="w", dir=root, prefix=".dev-processes-", delete=False) as out:
        json.dump({"root": str(root), "services": records}, out)
        temp = out.name
    os.replace(temp, root / ".dev-processes.json")


def track(root, name, pid):
    # A background shell may still be entering its application's directory.
    for _ in range(20):
        started = identity(pid)
        if started and inside(root, cwd(pid)):
            records = read_records(root)
            records[name] = {"pid": pid, "started": started}
            write_records(root, records)
            return
        time.sleep(0.05)
    raise RuntimeError(f"Cannot verify ownership of {name} (PID {pid}); process was not registered.")


def tree(root, record, protected):
    pid = record["pid"]
    if pid in protected or not matches(root, record):
        return []
    result = [record]
    children = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True)
    for child in children.stdout.split():
        child_pid = int(child)
        child_record = {"pid": child_pid, "started": identity(child_pid)}
        result.extend(tree(root, child_record, protected))
    return result


def signal_verified(root, record, sig):
    if matches(root, record):
        try:
            os.kill(record["pid"], sig)
        except ProcessLookupError:
            pass


def stop(root, name=None):
    records = read_records(root)
    selected = {key: value for key, value in records.items() if name is None or key == name}
    protected = ancestors()
    targets = {}
    for service, record in selected.items():
        owned = tree(root, record, protected)
        if not owned:
            print(f"Skipping stopped or unverified {service} (PID {record.get('pid')}).")
        for process in owned:
            targets[process["pid"]] = process
    # Snapshot descendants before signalling their parents; recheck identity
    # and checkout directory before every signal, including forced termination.
    for record in reversed(list(targets.values())):
        signal_verified(root, record, signal.SIGTERM)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and any(matches(root, r) for r in targets.values()):
        time.sleep(0.05)
    for record in reversed(list(targets.values())):
        signal_verified(root, record, signal.SIGKILL)
    for service in selected:
        del records[service]
    write_records(root, records)

    legacy = root / ".dev-pids"
    if legacy.exists():
        remaining = []
        for line in legacy.read_text().splitlines():
            service = line.partition(":")[0]
            if name is not None and service != name:
                remaining.append(line)
            elif service not in selected:
                print(f"Ignoring legacy {service} PID without an identity record. "
                      "Stop pre-upgrade servers from their original terminal if still running.")
        if remaining:
            legacy.write_text("\n".join(remaining) + "\n")
        else:
            legacy.unlink()
    print(f"Stopped {len(targets)} verified process(es) in {root}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    commands = parser.add_subparsers(dest="command", required=True)
    register = commands.add_parser("track")
    register.add_argument("name")
    register.add_argument("pid", type=int)
    running = commands.add_parser("running")
    running.add_argument("name")
    running.add_argument("pid", type=int)
    stop_parser = commands.add_parser("stop")
    stop_parser.add_argument("--name")
    commands.add_parser("list")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if args.command == "track":
        track(root, args.name, args.pid)
    elif args.command == "stop":
        stop(root, args.name)
    else:
        records = read_records(root)
        if args.command == "running":
            if args.name == "*":
                return 0 if any(record.get("pid") == args.pid and matches(root, record)
                                for record in records.values()) else 1
            record = records.get(args.name, {})
            return 0 if record.get("pid") == args.pid and matches(root, record) else 1
        for service, record in records.items():
            if matches(root, record):
                print(f"{service}: {record['pid']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, TypeError, AttributeError, RuntimeError) as error:
        print(f"Development process management: {error}", file=sys.stderr)
        sys.exit(1)
