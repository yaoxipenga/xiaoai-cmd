#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重算 Songloft 插件双层哈希并打包 .jsplugin.zip。

哈希算法与宿主 internal/jsplugin/hash.go 完全一致：
  entryHash = sha256(zip 内 main.js 的原始字节)
  zipHash   = 枚举 zip 内所有非 plugin.json 的普通文件，按路径升序，
              逐条拼接 "<path>\\n<sha256Hex(content)>\\n"，再对整体取 sha256。
"""
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PLUGIN_DIR = ROOT.parent / "xiaoai-text-command.jsplugin"
DESKTOP_ZIP = ROOT.parent / "xiaoai-text-command.jsplugin.zip"

# zip 内只包含运行所需文件；仓库里的 README / 脚本 / registry 不进包。
ZIP_FILES = ["main.js", "static/index.html", "static/icon.svg"]


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_zip_hash(files) -> str:
    h = hashlib.sha256()
    for rel, data in sorted(files, key=lambda x: x[0]):
        h.update(rel.encode("utf-8") + b"\n")
        h.update(sha256_hex(data).encode("ascii") + b"\n")
    return h.hexdigest()


def main():
    payload = [(rel, (ROOT / rel).read_bytes()) for rel in ZIP_FILES]
    entry_hash = sha256_hex((ROOT / "main.js").read_bytes())
    zip_hash = canonical_zip_hash(payload)

    for name in ("plugin.json", "manifest.json"):
        p = ROOT / name
        d = json.loads(p.read_text(encoding="utf-8"))
        d["entryHash"] = entry_hash
        d["zipHash"] = zip_hash
        p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    zip_path = ROOT / "xiaoai-text-command.jsplugin.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(ROOT / "plugin.json", "plugin.json")
        for rel, _ in payload:
            z.write(ROOT / rel, rel)

    # 按宿主算法从成品 zip 反算并校验
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        assert "main.js" in names and "plugin.json" in names, names
        assert sha256_hex(z.read("main.js")) == entry_hash
        inner = [(n, z.read(n)) for n in names if n != "plugin.json"]
        assert canonical_zip_hash(inner) == zip_hash

    # 同步到开发目录，方便本地直接安装验证
    if PLUGIN_DIR.exists():
        shutil.copy2(ROOT / "plugin.json", PLUGIN_DIR / "plugin.json")
        shutil.copy2(ROOT / "main.js", PLUGIN_DIR / "main.js")
        shutil.copy2(ROOT / "static/index.html", PLUGIN_DIR / "static/index.html")
        shutil.copy2(ROOT / "static/icon.svg", PLUGIN_DIR / "static/icon.svg")
    shutil.copy2(zip_path, DESKTOP_ZIP)

    print("entryHash :", entry_hash)
    print("zipHash   :", zip_hash)
    print("zip       :", zip_path, zip_path.stat().st_size, "bytes")
    print("entries   :", names)
    homepage = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))["homepage"]
    print("registry  : " + homepage.replace("https://github.com/", "https://raw.githubusercontent.com/")
          + "/main/registry.json")


if __name__ == "__main__":
    main()
