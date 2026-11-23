#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重算 Songloft 插件双层哈希并打包 .jsplugin.zip（v2.0.0 正式发布版）。

哈希算法与宿主 internal/jsplugin/hash.go 完全一致：
  entryHash = sha256(zip 内 main.js 的原始字节)
  zipHash   = 枚举 zip 内所有非 plugin.json 的普通文件，按路径升序，
              逐条拼接 "<path>\\n<sha256Hex(content)>\\n"，再对整体取 sha256。

用法：
  python build.py              # 重算哈希、写回 plugin/manifest、重新打包 zip
  python build.py --check      # 只校验现有 zip 与两个 json 是否自洽，不写文件
  python build.py --sync-dev   # 额外同步运行文件到 ./xiaoai-text-command.jsplugin/

产物 xiaoai-text-command.jsplugin.zip 随仓库一起提交，供 plugin.json 的
download_url（GitHub raw）直接分发，不需要额外创建 GitHub Release。
"""
import argparse
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ZIP_NAME = "xiaoai-text-command.jsplugin.zip"
DEV_DIR = ROOT / "xiaoai-text-command.jsplugin"

# zip 内只包含运行所需文件；README / 脚本 / registry / docs 都不进包。
ZIP_FILES = ["main.js", "static/index.html", "static/icon.svg"]


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_zip_hash(files) -> str:
    h = hashlib.sha256()
    for rel, data in sorted(files, key=lambda x: x[0]):
        h.update(rel.encode("utf-8") + b"\n")
        h.update(sha256_hex(data).encode("ascii") + b"\n")
    return h.hexdigest()


def compute():
    payload = [(rel, (ROOT / rel).read_bytes()) for rel in ZIP_FILES]
    return sha256_hex((ROOT / "main.js").read_bytes()), canonical_zip_hash(payload), payload


def verify_zip(zip_path, entry_hash, zip_hash):
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        assert "main.js" in names and "plugin.json" in names, names
        assert sha256_hex(z.read("main.js")) == entry_hash, "entryHash mismatch"
        inner = [(n, z.read(n)) for n in names if n != "plugin.json"]
        assert canonical_zip_hash(inner) == zip_hash, "zipHash mismatch"
        return names, json.loads(z.read("plugin.json"))


def main():
    ap = argparse.ArgumentParser(description="Rebuild Songloft .jsplugin.zip and its double hashes")
    ap.add_argument("--check", action="store_true", help="verify only, do not write anything")
    ap.add_argument("--sync-dev", action="store_true", help="also copy runtime files to ./xiaoai-text-command.jsplugin/")
    args = ap.parse_args()

    entry_hash, zip_hash, payload = compute()
    plugin = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    zip_path = ROOT / ZIP_NAME

    if args.check:
        assert plugin["version"] == manifest["version"], "version mismatch"
        assert plugin["entryHash"] == manifest["entryHash"] == entry_hash, "entryHash mismatch"
        assert plugin["zipHash"] == manifest["zipHash"] == zip_hash, "zipHash mismatch"
        names, meta = verify_zip(zip_path, entry_hash, zip_hash)
        assert meta["version"] == plugin["version"], "zip plugin.json version mismatch"
        print("CHECK OK | version", plugin["version"], "| zip entries", names)
        return

    for name in ("plugin.json", "manifest.json"):
        p = ROOT / name
        d = json.loads(p.read_text(encoding="utf-8"))
        d["entryHash"] = entry_hash
        d["zipHash"] = zip_hash
        p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(ROOT / "plugin.json", "plugin.json")
        for rel, _ in payload:
            z.write(ROOT / rel, rel)

    # 按宿主算法从成品 zip 反算校验
    names, meta = verify_zip(zip_path, entry_hash, zip_hash)
    assert meta["version"] == plugin["version"], "zip plugin.json version mismatch"

    if args.sync_dev and DEV_DIR.exists():
        for rel in ZIP_FILES:
            shutil.copy2(ROOT / rel, DEV_DIR / rel)
        shutil.copy2(ROOT / "plugin.json", DEV_DIR / "plugin.json")
        print("synced dev dir:", DEV_DIR)

    print("version   :", plugin["version"])
    print("entryHash :", entry_hash)
    print("zipHash   :", zip_hash)
    print("zip       :", zip_path, zip_path.stat().st_size, "bytes")
    print("entries   :", names)
    print("registry  : https://raw.githubusercontent.com/"
          + plugin["homepage"].split("github.com/")[-1] + "/main/registry.json")


if __name__ == "__main__":
    main()
