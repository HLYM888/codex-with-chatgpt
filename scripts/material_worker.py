#!/usr/bin/env python3
"""只读材料子进程，协议版本 1。Python >= 3.10。

运行：python material_worker.py < request.json
导入：handle({"contentBase64": "...", "request": {...}}) -> JSON-compatible dict

输入文件仅来自内存 bytes；不接受文件路径、不调用网络/命令、不写文件。
Node 负责根目录授权、同流文件版本、子进程硬超时与输入/输出限额。
解析器有结构和解压预算；当前不声明操作系统级内存硬上限。
本模块的 handle 是同步单请求入口；不要并发共享其进程全局状态。

selectors（均从1开始）：
  pdf read: page=1,count=1（<=5）；image: page=1。
  docx read/overview: start=1,count=20（<=50），正文块而非版面页。
  xlsx read: sheet 必填，range 必填，最多500个网格位置。
  csv read: start=1,count=20（<=50），或 range=A1:D10（<=500格）；
            行是CSV逻辑记录，另给实际物理行范围；encoding 默认utf8，不猜编码。
  pptx read/overview: start 或 page=1,count=20（<=50），XML形状顺序非视觉顺序。
  image overview/image；PNG/JPEG/WebP。image操作不执行OCR。

依赖：pdf=pypdf+pypdfium2+Pillow；image=Pillow；xlsx日期/共享公式=
openpyxl。DOCX/PPTX读取使用经安全检查的标准库OOXML，不需要Office程序。
不支持的格式/操作明确拒绝。所有成功data包含原件SHA-256及覆盖范围。
超预算明确失败，不返回被截断且冒充完整的文本/表格/图片。
"""
from __future__ import annotations

import base64
import binascii
import codecs
import contextlib
import csv
import hashlib
import importlib
import io
import json
import logging
import math
import posixpath
import re
import stat
import struct
import sys
import warnings
import zipfile
from datetime import datetime, time, timedelta
from typing import Any
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
from xml.parsers import expat

PROTOCOL_VERSION = 1
MAX_STDIN_BYTES = 46 * 1024 * 1024
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_STDOUT_BYTES = 2 * 1024 * 1024
MAX_DATA_BYTES = 128 * 1024
MAX_IMAGE_BYTES = 1024 * 1024
MAX_IMAGE_SIDE = 1600
MAX_IMAGE_PIXELS = 20_000_000
MAX_ZIP_ENTRIES = 2048
MAX_ZIP_TOTAL = 64 * 1024 * 1024
MAX_ZIP_ENTRY = 16 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
MAX_XML_NODES = 200_000
MAX_XML_DEPTH = 64
MAX_DOC_UNITS = 20_000
MAX_PAGES = 2000
MAX_TABLE_CELLS = 500
MAX_SHEET_CELLS = 100_000
MAX_SHEETS = 128
MAX_CSV_RECORDS = 100_000
MAX_CSV_COLUMNS = 1024
MAX_CSV_FIELD = MAX_DATA_BYTES

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
MAIN_PART = {"xlsx": "xl/workbook.xml", "docx": "word/document.xml", "pptx": "ppt/presentation.xml"}
MAIN_TYPE = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
}
FORMAT_OPERATIONS = {
    "pdf": {"overview", "read", "image"}, "image": {"overview", "image"},
    "xlsx": {"overview", "read"}, "docx": {"overview", "read"},
    "csv": {"overview", "read"}, "pptx": {"overview", "read"},
}


class MaterialError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


def fail(code: str, message: str) -> None:
    raise MaterialError(code, message)


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      separators=(",", ":")).encode("utf-8", "strict")


def _dependency(name: str) -> Any:
    try:
        return importlib.import_module(name)
    except ImportError:
        fail("DEPENDENCY_MISSING", "当前解析功能所需依赖未安装，请在集成环境核对。")


def _integer(req: dict, key: str, default: int, maximum: int) -> int:
    value = req.get(key, default)
    if type(value) is not int or not 1 <= value <= maximum:
        fail("INVALID_REQUEST", f"{key}必须是1至{maximum}之间的整数。")
    return value


def _slice(start: int, count: int, total: int) -> tuple[int, dict]:
    if total == 0 or start > total:
        fail("RANGE_NOT_FOUND", "请求的页、正文块或记录不存在。")
    end = min(total, start + count - 1)
    return end, {"start": start, "end": end, "returned": end-start+1,
                 "requestedCount": count, "total": total,
                 "nextStart": end + 1 if end < total else None}


def _paginated(items: list, start: int, count: int) -> tuple[list, dict]:
    if not items and start == 1:
        return [], {"start": 1, "end": 0, "returned": 0,
                    "requestedCount": count, "total": 0, "nextStart": None}
    end, selection = _slice(start, count, len(items))
    return items[start-1:end], selection


def _validate(payload: Any) -> tuple[bytes, dict]:
    if not isinstance(payload, dict) or set(payload) != {"contentBase64", "request"}:
        fail("INVALID_REQUEST", "输入必须且只能包含contentBase64与request。")
    req = payload["request"]
    if not isinstance(req, dict) or set(req) - {"format", "operation", "page", "start", "count", "sheet", "range", "encoding"}:
        fail("INVALID_REQUEST", "request必须为对象，且不得含未知参数。")
    fmt, op = req.get("format"), req.get("operation")
    if not isinstance(fmt, str) or fmt not in FORMAT_OPERATIONS:
        fail("UNSUPPORTED_FORMAT", "不支持该材料格式。")
    if not isinstance(op, str) or op not in FORMAT_OPERATIONS[fmt]:
        fail("UNSUPPORTED_OPERATION", "该格式不支持此操作。")
    for key in ("page", "start", "count"):
        if key in req:
            _integer(req, key, 1, 1_048_576)
    for key in ("sheet", "range", "encoding"):
        if key in req and (not isinstance(req[key], str) or not req[key] or len(req[key]) > 256):
            fail("INVALID_REQUEST", f"{key}必须是非空且有界的字符串。")
    allowed = {
        "pdf": {"page", "count"} if op == "read" else ({"page"} if op == "image" else set()),
        "image": set(), "xlsx": {"sheet", "range"} if op == "read" else set(),
        "docx": {"start", "count"}, "pptx": {"start", "page", "count"},
        "csv": {"encoding", "start", "count", "range"} if op == "read" else {"encoding"},
    }[fmt]
    if set(req) - {"format", "operation"} - allowed:
        fail("INVALID_REQUEST", "该格式或操作收到了不适用的范围参数。")
    if fmt == "csv" and "range" in req and ("start" in req or "count" in req):
        fail("INVALID_REQUEST", "CSV的range与start/count不能同时指定。")
    if fmt == "pptx" and "page" in req and "start" in req and req["page"] != req["start"]:
        fail("INVALID_REQUEST", "page与start不能指向不同幻灯片。")
    encoded = payload["contentBase64"]
    if not isinstance(encoded, str):
        fail("INVALID_BASE64", "contentBase64必须为标准Base64字符串。")
    if len(encoded) > 4 * ((MAX_FILE_BYTES + 2) // 3):
        fail("FILE_TOO_LARGE", "原始文件超过32 MiB限制。")
    try:
        raw = base64.b64decode(encoded, validate=True)
        if base64.b64encode(raw).decode("ascii") != encoded:
            fail("INVALID_BASE64", "Base64编码不规范。")
    except (ValueError, binascii.Error, UnicodeError):
        fail("INVALID_BASE64", "Base64内容无效。")
    if len(raw) > MAX_FILE_BYTES:
        fail("FILE_TOO_LARGE", "原始文件超过32 MiB限制。")
    if not raw and fmt != "csv":
        fail("EMPTY_FILE", "文件内容为空。")
    return raw, req


# XML由Expat先校验；不允许DTD、实体声明、外部实体，之后才交给ElementTree。
def _safe_xml(raw: bytes) -> ET.Element:
    if len(raw) > MAX_ZIP_ENTRY:
        fail("XML_LIMIT", "XML部件超过大小限制。")
    parser = expat.ParserCreate()
    depth = nodes = 0

    def forbidden(*args: Any) -> None:
        fail("UNSAFE_XML", "拒绝包含DTD或实体声明的XML。")

    def start(name: str, attrs: dict) -> None:
        nonlocal depth, nodes
        depth += 1
        nodes += 1
        if depth > MAX_XML_DEPTH or nodes > MAX_XML_NODES or len(attrs) > 256:
            fail("XML_LIMIT", "XML结构超过深度、节点或属性限制。")

    def end(name: str) -> None:
        nonlocal depth
        depth -= 1

    parser.StartDoctypeDeclHandler = forbidden
    parser.EntityDeclHandler = forbidden
    parser.ExternalEntityRefHandler = forbidden
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    try:
        parser.Parse(raw, True)
        return ET.fromstring(raw)
    except (expat.ExpatError, ET.ParseError, ValueError):
        fail("INVALID_XML", "Office内部XML损坏或编码无效。")


class OfficePackage:
    """有界、仅内存的OPC包。读取全部条目验证CRC，不向磁盘解包。"""
    def __init__(self, raw: bytes, fmt: str) -> None:
        if not raw.startswith(b"PK\x03\x04"):
            fail("FORMAT_MISMATCH", "格式声明与Office文件内容不符。")
        eocd = raw.rfind(b"PK\x05\x06", max(0, len(raw)-65557))
        if eocd < 0 or eocd+22 > len(raw):
            fail("CORRUPT_FILE", "Office ZIP目录损坏。")
        fields = struct.unpack_from("<4s4H2IH", raw, eocd)
        _, disk, cd_disk, n_disk, count, cd_size, cd_offset, comment_len = fields
        if eocd+22+comment_len != len(raw) or disk or cd_disk or n_disk != count:
            fail("CORRUPT_FILE", "不支持多卷或附加尾部数据的Office包。")
        if count == 65535 or cd_size == 0xffffffff or cd_offset == 0xffffffff:
            fail("ZIP_LIMIT", "不支持ZIP64材料包。")
        if count > MAX_ZIP_ENTRIES:
            fail("ZIP_LIMIT", "Office包条目数超限。")
        self.parts: dict[str, bytes] = {}
        self.external_links = 0
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                infos = z.infolist()
                if len(infos) != count or len(infos) > MAX_ZIP_ENTRIES:
                    fail("CORRUPT_FILE", "Office ZIP条目计数不一致。")
                total = 0
                seen: set[str] = set()
                for info in infos:
                    # ZipInfo normalizes Windows separators and truncates NUL in
                    # filename. Validate the original directory name first.
                    name = info.orig_filename
                    if (not name or len(name) > 512 or "\\" in name or "\x00" in name
                        or name.startswith("/") or ":" in name or any(p in {".", ".."} for p in name.rstrip("/").split("/"))
                        or "//" in name or stat.S_ISLNK(info.external_attr >> 16)):
                        fail("UNSAFE_ZIP", "Office包包含不安全的部件路径。")
                    if name.casefold() in seen:
                        fail("UNSAFE_ZIP", "Office包包含重复或大小写歧义部件。")
                    seen.add(name.casefold())
                    if info.flag_bits & 1:
                        fail("ENCRYPTED_FILE", "不读取加密Office包。")
                    if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                        fail("UNSUPPORTED_COMPRESSION", "Office部件压缩方式不受支持。")
                    total += info.file_size
                    if (info.file_size > MAX_ZIP_ENTRY or total > MAX_ZIP_TOTAL
                        or info.file_size > MAX_COMPRESSION_RATIO * max(info.compress_size, 1)):
                        fail("ZIP_LIMIT", "Office包解压体积或压缩比超限。")
                    lower = name.lower()
                    if ("vbaproject" in lower or "/activex/" in lower or "/embeddings/" in lower
                        or lower.endswith((".exe", ".dll", ".js", ".vbs"))):
                        fail("ACTIVE_CONTENT", "拒绝宏、嵌入对象或可执行部件。")
                    data = z.read(info)
                    if len(data) != info.file_size:
                        fail("CORRUPT_FILE", "Office部件大小不一致。")
                    self.parts[name] = data
                    if lower.endswith((".xml", ".rels")):
                        tree = _safe_xml(data)
                        if lower.endswith(".rels"):
                            self.external_links += sum(1 for el in tree if el.get("TargetMode", "").lower() == "external")
                if "[Content_Types].xml" not in self.parts:
                    fail("FORMAT_MISMATCH", "缺少Office内容类型声明。")
                types = self.xml("[Content_Types].xml")
                if types.tag != f"{{{CT}}}Types":
                    fail("FORMAT_MISMATCH", "Office内容类型命名空间不受支持。")
                overrides = {}
                for el in types:
                    ct = el.get("ContentType", "")
                    if any(s in ct.lower() for s in ("macroenabled", "macrosheet", "vbaproject", "activex", "oleobject")):
                        fail("ACTIVE_CONTENT", "不支持包含宏或活动对象的Office格式。")
                    if el.tag == f"{{{CT}}}Override":
                        part = el.get("PartName", "").lstrip("/")
                        if part in overrides:
                            fail("CORRUPT_FILE", "Office内容类型重复。")
                        overrides[part] = ct
                main = MAIN_PART[fmt]
                if overrides.get(main) != MAIN_TYPE[fmt] or main not in self.parts:
                    fail("FORMAT_MISMATCH", "Office主文档类型与请求格式不一致。")
                if any(other != fmt and MAIN_PART[other] in self.parts for other in MAIN_PART):
                    fail("FORMAT_MISMATCH", "Office包中存在冲突的主文档类型。")
                root_rels = self.relationships("")
                mains = [rel for rel in root_rels.values() if rel[0].endswith("/officeDocument")]
                if len(mains) != 1 or mains[0][1] != main or mains[0][2]:
                    fail("FORMAT_MISMATCH", "Office根关系未绑定预期主文档。")
        except (zipfile.BadZipFile, RuntimeError, EOFError, NotImplementedError):
            fail("CORRUPT_FILE", "Office ZIP数据损坏或无法解压。")

    def xml(self, part: str) -> ET.Element:
        if part not in self.parts:
            fail("CORRUPT_FILE", "Office引用的必要部件不存在。")
        return _safe_xml(self.parts[part])

    def relationships(self, owner: str) -> dict[str, tuple[str, str, bool]]:
        part = posixpath.join(posixpath.dirname(owner), "_rels", posixpath.basename(owner)+".rels") if owner else "_rels/.rels"
        if part not in self.parts:
            return {}
        root = self.xml(part)
        if root.tag != f"{{{REL}}}Relationships":
            fail("CORRUPT_FILE", "Office关系部件无效。")
        result = {}
        for el in root:
            ident, target, typ = el.get("Id"), el.get("Target"), el.get("Type", "")
            if not ident or target is None or ident in result:
                fail("CORRUPT_FILE", "Office关系标识缺失或重复。")
            external = el.get("TargetMode", "").lower() == "external"
            if not external:
                decoded = unquote(target)
                if "\\" in decoded or urlsplit(decoded).scheme or "\x00" in decoded or decoded.startswith("//"):
                    fail("UNSAFE_ZIP", "拒绝Office关系中的外部或异常路径。")
                resolved = posixpath.normpath(decoded.lstrip("/") if decoded.startswith("/") else posixpath.join(posixpath.dirname(owner), decoded))
                if resolved == ".." or resolved.startswith("../"):
                    fail("UNSAFE_ZIP", "Office关系越出材料包。")
                target = resolved
            result[ident] = (typ, target, external)
        return result

    def related(self, owner: str, rid: str, suffix: str) -> str:
        rel = self.relationships(owner).get(rid)
        if rel is None or rel[2] or not rel[0].endswith("/"+suffix) or rel[1] not in self.parts:
            fail("CORRUPT_FILE", "Office内容关系无效或目标不存在。")
        return rel[1]


def _base(fmt: str, coverage: str) -> dict:
    return {"format": fmt, "coverage": {"scope": coverage, "completeForSelection": True},
            "truncated": False, "warnings": []}


def _office_warnings(pkg: OfficePackage, data: dict) -> None:
    data["externalLinksIgnored"] = pkg.external_links
    if pkg.external_links:
        data["warnings"].append("外部链接仅计数，未访问、更新或执行。")


def _cell_coords(address: str) -> tuple[int, int]:
    m = re.fullmatch(r"\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})", address)
    if not m:
        fail("INVALID_RANGE", "单元格地址必须为有界A1格式。")
    col = 0
    for ch in m[1].upper():
        col = col * 26 + ord(ch)-64
    row = int(m[2])
    if col > 16384 or row > 1048576:
        fail("INVALID_RANGE", "单元格地址越出XLSX网格。")
    return row, col


def _address(row: int, col: int) -> str:
    prefix = ""
    while col:
        col, rem = divmod(col-1, 26)
        prefix = chr(65+rem) + prefix
    return prefix + str(row)


def _range(value: str) -> tuple[int, int, int, int]:
    pieces = value.split(":")
    if len(pieces) not in {1, 2}:
        fail("INVALID_RANGE", "只接受单个连续A1单元格范围。")
    r1, c1 = _cell_coords(pieces[0])
    r2, c2 = _cell_coords(pieces[-1])
    if r2 < r1 or c2 < c1:
        fail("INVALID_RANGE", "范围终点不得位于起点之前。")
    if (r2-r1+1)*(c2-c1+1) > MAX_TABLE_CELLS:
        fail("RANGE_LIMIT", "单次最多读取500个单元格。")
    return r1, c1, r2, c2


def _sheet_records(pkg: OfficePackage, part: str) -> tuple[ET.Element, dict]:
    root = pkg.xml(part)
    if root.tag != f"{{{S}}}worksheet":
        fail("UNSUPPORTED_FEATURE", "仅支持普通XLSX工作表。")
    result = {}
    sheet_data = root.find(f"{{{S}}}sheetData")
    if sheet_data is not None:
        for row in sheet_data.findall(f"{{{S}}}row"):
            for cell in row.findall(f"{{{S}}}c"):
                coord = _cell_coords(cell.get("r", ""))
                if coord in result:
                    fail("CORRUPT_FILE", "工作表含重复单元格地址。")
                result[coord] = cell
                if len(result) > MAX_SHEET_CELLS:
                    fail("CONTENT_LIMIT", "工作表实际单元格数量超过解析上限。")
    return root, result


def _sheet_dimensions(root: ET.Element, records: dict) -> dict:
    declared = root.find(f"{{{S}}}dimension")
    observed = None
    if records:
        observed = _address(min(r for r, c in records), min(c for r, c in records))+":"+_address(max(r for r, c in records), max(c for r, c in records))
    return {"declaredRange": declared.get("ref") if declared is not None else None,
            "declaredRangeTrustedForIteration": False,
            "observedRange": observed, "presentCellCount": len(records)}


def _xlsx(pkg: OfficePackage, req: dict) -> dict:
    wb = pkg.xml("xl/workbook.xml")
    if wb.tag != f"{{{S}}}workbook":
        fail("UNSUPPORTED_FEATURE", "不支持该工作簿XML命名空间。")
    sheets_el = wb.find(f"{{{S}}}sheets")
    sheets = list(sheets_el) if sheets_el is not None else []
    if len(sheets) > MAX_SHEETS:
        fail("CONTENT_LIMIT", "工作表数量超过上限。")
    info = []
    names = set()
    for index, sheet in enumerate(sheets, 1):
        name = sheet.get("name")
        if not name or name in names:
            fail("CORRUPT_FILE", "工作表名称缺失或重复。")
        names.add(name)
        part = pkg.related("xl/workbook.xml", sheet.get(f"{{{R}}}id", ""), "worksheet")
        info.append((name, part, sheet.get("state", "visible")))
    data = _base("xlsx", "指定网格的原始值、公式与存储缓存；不计算公式，不更新外链。")
    _office_warnings(pkg, data)
    prop = wb.find(f"{{{S}}}workbookPr")
    epoch1904 = prop is not None and prop.get("date1904", "0").lower() in {"1", "true"}
    data.update(dateSystem="1904" if epoch1904 else "1900", formulaCalculation=False,
                hiddenSheetsIncluded=True)
    if req["operation"] == "overview":
        data["sheets"] = []
        for index, (name, part, state) in enumerate(info, 1):
            root, records = _sheet_records(pkg, part)
            data["sheets"].append({"index": index, "name": name, "state": state, **_sheet_dimensions(root, records)})
        data["sheetCount"] = len(info)
        return data
    if "sheet" not in req or "range" not in req:
        fail("INVALID_REQUEST", "XLSX读取必须指定sheet和range。")
    entry = next((v for v in info if v[0] == req["sheet"]), None)
    if entry is None:
        fail("SHEET_NOT_FOUND", "指定工作表不存在。")
    r1, c1, r2, c2 = _range(req["range"])
    root, records = _sheet_records(pkg, entry[1])
    nums = _dependency("openpyxl.styles.numbers")
    dates = _dependency("openpyxl.utils.datetime")
    rels = pkg.relationships("xl/workbook.xml")
    shared = []
    formats = ["General"]
    for typ, part, external in rels.values():
        if external:
            continue
        if typ.endswith("/sharedStrings"):
            sst = pkg.xml(part)
            shared = ["".join(t.text or "" for t in item.iter(f"{{{S}}}t")) for item in sst.findall(f"{{{S}}}si")]
        if typ.endswith("/styles"):
            style_root = pkg.xml(part)
            custom = {int(el.get("numFmtId", "-1")): el.get("formatCode", "") for el in style_root.findall(f"{{{S}}}numFmts/{{{S}}}numFmt")}
            formats = []
            for el in style_root.findall(f"{{{S}}}cellXfs/{{{S}}}xf"):
                idx = int(el.get("numFmtId", "0"))
                fmt = custom.get(idx, nums.BUILTIN_FORMATS.get(idx))
                if fmt is None:
                    fail("UNSUPPORTED_FEATURE", "工作簿使用无法识别的数字格式。")
                formats.append(fmt)
    shared_formulas = {}
    for coord, cell in records.items():
        f = cell.find(f"{{{S}}}f")
        if f is not None and f.get("t") == "shared" and f.text:
            sid = f.get("si")
            if sid in shared_formulas:
                fail("CORRUPT_FILE", "共享公式主定义重复。")
            shared_formulas[sid] = (_address(*coord), "="+f.text)

    def value_of(cell: ET.Element, number_format: str) -> tuple[Any, str, Any, bool]:
        typ = cell.get("t", "n")
        v = cell.find(f"{{{S}}}v")
        raw_value = v.text if v is not None else None
        if typ == "inlineStr":
            inline = cell.find(f"{{{S}}}is")
            text = "".join(t.text or "" for t in inline.iter(f"{{{S}}}t")) if inline is not None else None
            return text, "string" if inline is not None else "blank", text, inline is not None
        if v is None or raw_value is None:
            if typ == "str" and v is not None:
                return "", "string", "", True
            return None, "blank", raw_value, False
        if typ == "s":
            try:
                index = int(raw_value)
                if index < 0: raise ValueError()
                return shared[index], "string", raw_value, True
            except (ValueError, IndexError):
                fail("CORRUPT_FILE", "共享字符串索引无效。")
        if typ in {"str", "e"}:
            return raw_value, "error" if typ == "e" else "string", raw_value, True
        if typ == "b":
            if raw_value not in {"0", "1"}:
                fail("CORRUPT_FILE", "布尔单元格无效。")
            return raw_value == "1", "boolean", raw_value, True
        if typ == "d":
            try:
                parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
            except ValueError:
                fail("CORRUPT_FILE", "日期单元格不是有效ISO日期。")
            return {"iso8601": parsed.isoformat(), "timezone": "stored_or_unspecified"}, "datetime", raw_value, True
        if typ != "n":
            fail("UNSUPPORTED_FEATURE", "单元格类型不受支持。")
        try:
            number = float(raw_value)
        except ValueError:
            fail("CORRUPT_FILE", "数字单元格内容无效。")
        if not math.isfinite(number):
            fail("CORRUPT_FILE", "数字单元格包含非有限值。")
        if nums.is_date_format(number_format):
            if not epoch1904 and 60 <= number < 61:
                val = {"iso8601": None, "excelSerial": number, "note": "Excel1900虚构闰日，不映射为真实日期"}
                return val, "excel1900LeapDay", raw_value, True
            try:
                parsed = dates.from_excel(number, epoch=dates.MAC_EPOCH if epoch1904 else dates.WINDOWS_EPOCH,
                                          timedelta=nums.is_timedelta_format(number_format))
            except (ValueError, OverflowError):
                fail("CORRUPT_FILE", "日期序列超出可表示范围。")
            if isinstance(parsed, timedelta):
                val, out_type = {"totalSeconds": parsed.total_seconds(), "excelSerial": number}, "duration"
            else:
                val = {"iso8601": parsed.isoformat(), "excelSerial": number, "timezone": "unspecified"}
                out_type = "time" if isinstance(parsed, time) else "datetime"
            return val, out_type, raw_value, True
        return int(number) if number.is_integer() and abs(number) <= 2**53 else number, "number", raw_value, True

    cells = []
    for row in range(r1, r2+1):
        for col in range(c1, c2+1):
            cell = records.get((row, col))
            address = _address(row, col)
            if cell is None:
                cells.append({"address": address, "present": False, "type": "missing", "rawValue": None,
                              "value": None, "formula": None, "cachePresent": False, "cachedValue": None, "cachedType": None})
                continue
            style_index = int(cell.get("s", "0"))
            if not 0 <= style_index < len(formats):
                fail("CORRUPT_FILE", "单元格样式索引无效。")
            fmt = formats[style_index]
            val, typ, raw_value, stored = value_of(cell, fmt)
            formula_el = cell.find(f"{{{S}}}f")
            formula = None
            if formula_el is not None:
                if formula_el.text:
                    formula = "="+formula_el.text
                elif formula_el.get("t") == "shared" and formula_el.get("si") in shared_formulas:
                    origin, source = shared_formulas[formula_el.get("si")]
                    formula = _dependency("openpyxl.formula.translate").Translator(source, origin=origin).translate_formula(address)
                else:
                    fail("UNSUPPORTED_FEATURE", "无法完整还原该单元格公式，未用缓存冒充公式。")
            cells.append({"address": address, "present": True, "rawType": cell.get("t", "n"),
                          "type": "formula" if formula_el is not None else typ,
                          "rawValue": raw_value, "value": formula if formula_el is not None else val,
                          "formula": formula, "formulaAttributes": dict(formula_el.attrib) if formula_el is not None else None,
                          "cachePresent": stored if formula_el is not None else False,
                          "cachedValue": val if formula_el is not None and stored else None,
                          "cachedType": typ if formula_el is not None and stored else None,
                          "numberFormat": fmt})
    merges = [el.get("ref") for el in root.findall(f"{{{S}}}mergeCells/{{{S}}}mergeCell")]
    if len(merges) > 2000:
        fail("CONTENT_LIMIT", "合并单元格元数据超限。")
    data.update(sheet=entry[0], sheetState=entry[2], range=f"{_address(r1,c1)}:{_address(r2,c2)}",
                cells=cells, cellCount=len(cells), dimensions=_sheet_dimensions(root, records), mergedRanges=merges)
    data["coverage"]["limitations"] = ["空网格位置以present=false明确表示，不推断存在原始数据。", "未读取批注、图表或条件格式；日期保留原始序列。", "缓存来自文件，未核实新鲜度。"]
    return data


def _word_text(el: ET.Element) -> str:
    pieces = []
    blocked = {f"{{{W}}}del", f"{{{W}}}moveFrom", f"{{{W}}}txbxContent", f"{{{W}}}instrText"}
    def walk(node: ET.Element) -> None:
        if node.tag in blocked:
            return
        if node.tag == f"{{{W}}}t":
            pieces.append(node.text or "")
        elif node.tag == f"{{{W}}}tab":
            pieces.append("\t")
        elif node.tag in {f"{{{W}}}br", f"{{{W}}}cr"}:
            pieces.append("\n")
        else:
            for child in node:
                walk(child)
    walk(el)
    return "".join(pieces)


def _word_table(table: ET.Element) -> dict:
    result, count = [], 0
    nested = False
    for ri, row in enumerate(table.findall(f"{{{W}}}tr"), 1):
        out_row = []
        for ci, cell in enumerate(row.findall(f"{{{W}}}tc"), 1):
            count += 1
            if count > MAX_TABLE_CELLS:
                fail("TABLE_LIMIT", "正文表格超过500格，未返回不完整表格。")
            span = cell.find(f"{{{W}}}tcPr/{{{W}}}gridSpan")
            vm = cell.find(f"{{{W}}}tcPr/{{{W}}}vMerge")
            n = int(span.get(f"{{{W}}}val", "1")) if span is not None else 1
            if n < 1 or n > 16384:
                fail("CORRUPT_FILE", "表格跨列数无效。")
            nested = nested or cell.find(f"{{{W}}}tbl") is not None
            out_row.append({"column": ci, "text": "\n".join(_word_text(p) for p in cell.findall(f"{{{W}}}p")),
                            "gridSpan": n, "verticalMerge": vm.get(f"{{{W}}}val", "continue") if vm is not None else None})
        result.append({"row": ri, "cells": out_row})
    return {"rows": result, "cellCount": count, "nestedTablesExcluded": nested}


def _docx(pkg: OfficePackage, req: dict) -> dict:
    root = pkg.xml("word/document.xml")
    body = root.find(f"{{{W}}}body")
    if root.tag != f"{{{W}}}document" or body is None:
        fail("UNSUPPORTED_FEATURE", "DOCX正文结构或命名空间不受支持。")
    blocks = [el for el in body if el.tag != f"{{{W}}}sectPr"]
    if len(blocks) > MAX_DOC_UNITS:
        fail("CONTENT_LIMIT", "DOCX正文块过多。")
    start = _integer(req, "start", 1, MAX_DOC_UNITS)
    count = _integer(req, "count", 20, 50)
    indexes, pc, tc = [], 0, 0
    for index, el in enumerate(blocks, 1):
        kind = "paragraph" if el.tag == f"{{{W}}}p" else "table" if el.tag == f"{{{W}}}tbl" else "unsupported"
        pc += kind == "paragraph"
        tc += kind == "table"
        item = {"index": index, "type": kind}
        if kind == "paragraph": item["paragraphIndex"] = pc
        if kind == "table": item["tableIndex"] = tc
        indexes.append(item)
    data = _base("docx", "主正文顶层块，按原始XML顺序。")
    _office_warnings(pkg, data)
    data.update(blockCount=len(blocks), paragraphCount=pc, tableCount=tc, pageCount=None,
                revisionMarkupPresent=any(el.tag in {f"{{{W}}}ins", f"{{{W}}}del", f"{{{W}}}moveFrom", f"{{{W}}}moveTo"} for el in body.iter()))
    data["coverage"]["limitations"] = ["无版面页码推断；页眉、页脚、批注、脚注、尾注、文本框和图片内容未提取。", "字段不执行；删除修订及移动前内容不读，未自动接受修订。", "嵌套表格、内容控件及其他顶层结构明确标为未覆盖。"]
    if req["operation"] == "read" and not blocks:
        fail("RANGE_NOT_FOUND", "DOCX没有可读取的正文块。")
    selected, selection = _paginated(indexes, start, count)
    data.update(selection=selection, truncated=selection["nextStart"] is not None)
    if req["operation"] == "overview":
        data["blocks"] = selected
        return data
    data["blocks"] = []
    for descriptor in selected:
        el = blocks[descriptor["index"]-1]
        item = dict(descriptor)
        if item["type"] == "paragraph":
            style = el.find(f"{{{W}}}pPr/{{{W}}}pStyle")
            item.update(text=_word_text(el), styleId=style.get(f"{{{W}}}val") if style is not None else None,
                        imagesExcluded=any(n.tag in {f"{{{W}}}drawing", f"{{{W}}}pict"} for n in el.iter()))
        elif item["type"] == "table":
            item.update(_word_table(el))
            if item["nestedTablesExcluded"]:
                data["coverage"]["completeForSelection"] = False
        else:
            item["tag"] = el.tag.rsplit("}", 1)[-1]
            data["coverage"]["completeForSelection"] = False
        data["blocks"].append(item)
    return data


def _drawing_text(el: ET.Element) -> list[str]:
    output = []
    for para in el.iter(f"{{{A}}}p"):
        pieces = []
        for node in para.iter():
            if node.tag == f"{{{A}}}t": pieces.append(node.text or "")
            elif node.tag == f"{{{A}}}br": pieces.append("\n")
        output.append("".join(pieces))
    return output


def _pptx(pkg: OfficePackage, req: dict) -> dict:
    root = pkg.xml("ppt/presentation.xml")
    if root.tag != f"{{{P}}}presentation":
        fail("UNSUPPORTED_FEATURE", "不支持该PPTX主文档命名空间。")
    slides = root.findall(f"{{{P}}}sldIdLst/{{{P}}}sldId")
    if len(slides) > MAX_PAGES:
        fail("CONTENT_LIMIT", "幻灯片数量超过上限。")
    start = _integer(req, "start", req.get("page", 1), MAX_PAGES)
    count = _integer(req, "count", 20, 50)
    selected, selection = _paginated(slides, start, count)
    if req["operation"] == "read" and not slides:
        fail("RANGE_NOT_FOUND", "演示文稿没有可读取幻灯片。")
    data = _base("pptx", "按幻灯片及XML形状顺序提取文字与表格。")
    _office_warnings(pkg, data)
    data.update(slideCount=len(slides), selection=selection, truncated=selection["nextStart"] is not None, slides=[])
    data["coverage"]["limitations"] = ["不渲染；不推断视觉阅读顺序。", "备注、图表数据、SmartArt、母版文本、动画、图片内容和外链未读取或执行。"]
    for index, slide in enumerate(selected, start):
        part = pkg.related("ppt/presentation.xml", slide.get(f"{{{R}}}id", ""), "slide")
        tree = pkg.xml(part)
        shapes = tree.find(f"{{{P}}}cSld/{{{P}}}spTree")
        item = {"page": index, "hidden": tree.get("show", "1") in {"0", "false"}, "title": None, "shapes": []}
        if shapes is None:
            fail("CORRUPT_FILE", "幻灯片缺少形状树。")
        def visit(nodes: ET.Element) -> None:
            for el in nodes:
                if el.tag == f"{{{P}}}grpSp":
                    visit(el)
                    continue
                if el.tag in {f"{{{P}}}nvGrpSpPr", f"{{{P}}}grpSpPr"}:
                    continue
                desc = next(iter(el.iter(f"{{{P}}}cNvPr")), None)
                shape = {"index": len(item["shapes"])+1, "name": desc.get("name") if desc is not None else None}
                table = el.find(f".//{{{A}}}tbl")
                if table is not None:
                    rows, total = [], 0
                    for ri, row in enumerate(table.findall(f"{{{A}}}tr"), 1):
                        cells = []
                        for ci, cell in enumerate(row.findall(f"{{{A}}}tc"), 1):
                            total += 1
                            if total > MAX_TABLE_CELLS: fail("TABLE_LIMIT", "幻灯片表格超过500格。")
                            cells.append({"column": ci, "text": "\n".join(_drawing_text(cell)),
                                          "gridSpan": cell.get("gridSpan", "1"), "rowSpan": cell.get("rowSpan", "1"),
                                          "hMerge": cell.get("hMerge", "0"), "vMerge": cell.get("vMerge", "0")})
                        rows.append({"row": ri, "cells": cells})
                    shape.update(type="table", rows=rows, cellCount=total)
                elif el.tag == f"{{{P}}}sp":
                    text = _drawing_text(el)
                    shape.update(type="text", paragraphs=text)
                    ph = el.find(f".//{{{P}}}ph")
                    if ph is not None and ph.get("type") in {"title", "ctrTitle"}:
                        item["title"] = "\n".join(text)
                elif el.tag == f"{{{P}}}pic":
                    shape.update(type="image", contentRead=False)
                else:
                    shape.update(type="unsupported", tag=el.tag.rsplit("}", 1)[-1])
                    data["coverage"]["completeForSelection"] = False
                item["shapes"].append(shape)
                if len(item["shapes"]) > 2000: fail("CONTENT_LIMIT", "幻灯片形状数超限。")
        visit(shapes)
        if req["operation"] == "overview":
            item = {"page": index, "hidden": item["hidden"], "title": item["title"],
                    "shapeCount": len(item["shapes"]), "tableCount": sum(v["type"] == "table" for v in item["shapes"])}
        data["slides"].append(item)
    return data


def _decode_csv(raw: bytes, requested: str) -> tuple[str, str]:
    names = {"utf8": "utf-8", "utf-8": "utf-8", "utf-8-sig": "utf-8", "utf16": "utf-16",
             "utf-16": "utf-16", "utf-16le": "utf-16-le", "utf-16-le": "utf-16-le",
             "utf-16be": "utf-16-be", "utf-16-be": "utf-16-be", "gbk": "gbk", "gb18030": "gb18030"}
    encoding = names.get(requested.lower())
    if encoding is None:
        fail("UNSUPPORTED_ENCODING", "不支持该CSV编码，未进行自动猜测。")
    bom = next(((mark, enc) for mark, enc in ((codecs.BOM_UTF8, "utf-8"), (codecs.BOM_UTF16_LE, "utf-16-le"), (codecs.BOM_UTF16_BE, "utf-16-be")) if raw.startswith(mark)), None)
    if raw.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        fail("UNSUPPORTED_ENCODING", "不支持UTF-32 CSV。")
    if bom:
        if encoding != bom[1] and not (encoding == "utf-16" and bom[1].startswith("utf-16")):
            fail("ENCODING_CONFLICT", "CSV编码声明与BOM冲突。")
        raw, encoding = raw[len(bom[0]):], bom[1]
        if raw.startswith((codecs.BOM_UTF8, codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
            fail("ENCODING_CONFLICT", "拒绝重复BOM。")
    elif encoding == "utf-16":
        fail("ENCODING_REQUIRED", "无BOM的UTF-16必须明确指定LE或BE。")
    try:
        text = raw.decode(encoding, errors="strict")
    except UnicodeError:
        fail("INVALID_ENCODING", "CSV字节不符合指定编码，未替换损坏字符。")
    if any(ord(ch) < 32 and ch not in "\t\r\n" for ch in text):
        fail("FORMAT_MISMATCH", "CSV包含二进制控制字符。")
    return text, encoding


def _csv(raw: bytes, req: dict) -> dict:
    if raw.startswith((b"PK\x03\x04", b"%PDF-", b"\x89PNG", b"\xff\xd8\xff")) or (raw.startswith(b"RIFF") and raw[8:12] == b"WEBP"):
        fail("FORMAT_MISMATCH", "二进制文件不能伪装为CSV。")
    text, encoding = _decode_csv(raw, req.get("encoding", "utf8"))
    selected, row_count, max_cols = [], 0, 0
    if "range" in req:
        r1, c1, r2, c2 = _range(req["range"])
    else:
        r1 = _integer(req, "start", 1, MAX_CSV_RECORDS)
        r2 = r1 + _integer(req, "count", 20, 50)-1
        c1, c2 = 1, None
    old = csv.field_size_limit()
    csv.field_size_limit(MAX_CSV_FIELD)
    try:
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        previous_line = 0
        for row in reader:
            row_count += 1
            if row_count > MAX_CSV_RECORDS or len(row) > MAX_CSV_COLUMNS:
                fail("CONTENT_LIMIT", "CSV逻辑记录数或列数超限。")
            max_cols = max(max_cols, len(row))
            if req["operation"] == "read" and r1 <= row_count <= r2:
                last = c2 if c2 is not None else len(row)
                cells = [{"column": col, "present": col <= len(row), "type": "text" if col <= len(row) else "missing",
                          "value": row[col-1] if col <= len(row) else None} for col in range(c1, last+1)]
                selected.append({"row": row_count, "physicalLines": {"start": previous_line+1, "end": reader.line_num}, "cells": cells})
                if sum(len(item["cells"]) for item in selected) > MAX_TABLE_CELLS:
                    fail("RANGE_LIMIT", "CSV单次读取超过500格，请缩小范围。")
            previous_line = reader.line_num
    except csv.Error:
        fail("INVALID_CSV", "CSV引号结构无效或字段大小超限。")
    finally:
        csv.field_size_limit(old)
    data = _base("csv", "逗号分隔CSV逻辑记录；不推断表头/类型，不执行公式。")
    data.update(encoding=encoding, rowCount=row_count, maxColumns=max_cols, delimiter=",")
    if req["operation"] == "read":
        end, selection = _slice(r1, r2-r1+1, row_count)
        if "range" in req and (r2 > row_count or c1 > max_cols):
            fail("RANGE_NOT_FOUND", "CSV请求范围不在实际记录范围内。")
        data.update(rows=selected, selection=selection, truncated=end < row_count)
    return data


class _LimitedImageBuffer(io.BytesIO):
    def write(self, data: bytes) -> int:
        if self.tell()+len(data) > MAX_IMAGE_BYTES:
            raise OverflowError("thumbnail limit")
        return super().write(data)


def _image_output(image: Any) -> tuple[dict, dict]:
    Image = _dependency("PIL.Image")
    ImageOps = _dependency("PIL.ImageOps")
    image = ImageOps.exif_transpose(image).copy()
    image.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.Resampling.LANCZOS)
    # 新图像不携带EXIF/ICC/文本块等输入元数据。
    alpha = image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info)
    image = image.convert("RGBA" if alpha else "RGB")
    image.info.clear()
    for _ in range(12):
        output = _LimitedImageBuffer()
        try:
            image.save(output, format="PNG")
            binary = output.getvalue()
            return ({"mimeType": "image/png", "data": base64.b64encode(binary).decode("ascii")},
                    {"width": image.width, "height": image.height, "byteLength": len(binary), "metadataRemoved": True})
        except OverflowError:
            if min(image.size) <= 1:
                break
            image = image.resize((max(1, int(image.width*.75)), max(1, int(image.height*.75))), Image.Resampling.LANCZOS)
    fail("IMAGE_LIMIT", "无法在图片预算内生成有效缩略图。")


def _image(raw: bytes, req: dict) -> tuple[dict, dict | None]:
    Image = _dependency("PIL.Image")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as check:
                if check.format not in {"PNG", "JPEG", "WEBP"}:
                    fail("FORMAT_MISMATCH", "仅接受PNG、JPEG或WebP图片。")
                fmt, size, frames = check.format, check.size, getattr(check, "n_frames", 1)
                if size[0]*size[1] > MAX_IMAGE_PIXELS or min(size) < 1:
                    fail("IMAGE_LIMIT", "图片像素数量超限。")
                check.verify()
            with Image.open(io.BytesIO(raw)) as source:
                source.load()
                data = _base("image", "第一帧图片；不执行OCR。")
                data.update(mimeType={"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[fmt],
                            width=size[0], height=size[1], frameCount=frames, frameRead=1, ocrPerformed=False)
                if frames > 1:
                    data["coverage"]["completeForSelection"] = False
                    data["warnings"].append("多帧图片只读取第一帧。")
                if req["operation"] == "overview": return data, None
                image, thumb = _image_output(source)
                data["thumbnail"] = thumb
                return data, image
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        fail("IMAGE_LIMIT", "图片解压像素超限。")
    except (OSError, SyntaxError, ValueError):
        fail("CORRUPT_FILE", "图片损坏或无法完整解码。")


def _pdf(raw: bytes, req: dict) -> tuple[dict, dict | None]:
    if not raw.startswith(b"%PDF-"):
        fail("FORMAT_MISMATCH", "文件内容不是受支持的PDF。")
    pypdf = _dependency("pypdf")
    try:
        reader = pypdf.PdfReader(io.BytesIO(raw), strict=True)
        if reader.is_encrypted:
            fail("ENCRYPTED_FILE", "不读取或尝试解密加密PDF。")
        pages = len(reader.pages)
        if pages > MAX_PAGES:
            fail("CONTENT_LIMIT", "PDF页数超过解析上限。")
        data = _base("pdf", "PDF文本层或指定页面栅格；不执行脚本、附件或OCR。")
        data.update(pageCount=pages, ocrPerformed=False)
        if req["operation"] == "overview":
            outline, visited, truncated = [], set(), False
            def walk(nodes: list, depth: int) -> None:
                nonlocal truncated
                if depth > 32: fail("CONTENT_LIMIT", "PDF目录嵌套超限。")
                if id(nodes) in visited: fail("CORRUPT_FILE", "PDF目录循环引用。")
                visited.add(id(nodes))
                for node in nodes:
                    if len(outline) >= 100:
                        truncated = True
                        return
                    if isinstance(node, list):
                        walk(node, depth+1)
                    else:
                        pn = reader.get_destination_page_number(node)
                        outline.append({"title": str(node.title), "page": pn+1 if pn is not None and pn >= 0 else None, "depth": depth})
            walk(reader.outline, 1)
            data.update(outline=outline, outlineTruncated=truncated, outlineLimit=100, truncated=truncated)
            if truncated:
                data["coverage"]["completeForSelection"] = False
                data["warnings"].append("目录只返回前100项；无目录续读接口，正文可按页读取。")
            return data, None
        page_no = _integer(req, "page", 1, MAX_PAGES)
        count = _integer(req, "count", 1, 5) if req["operation"] == "read" else 1
        end, selection = _slice(page_no, count, pages)
        pdfium = _dependency("pypdfium2")
        with pdfium.PdfDocument(raw) as doc:
            if len(doc) != pages: fail("CORRUPT_FILE", "PDF解析器对页数的判断不一致。")
            if req["operation"] == "image":
                with contextlib.closing(doc[page_no-1]) as page:
                    width, height = page.get_size()
                    if not all(math.isfinite(v) and 0 < v <= 200000 for v in (width, height)):
                        fail("IMAGE_LIMIT", "PDF页面尺寸无效或超限。")
                    scale = min(2.0, MAX_IMAGE_SIDE/max(width, height))
                    bitmap = page.render(scale=scale, may_draw_forms=False)
                    try:
                        pil = bitmap.to_pil().copy()
                    finally:
                        bitmap.close()
                    try:
                        image, thumb = _image_output(pil)
                    finally:
                        pil.close()
                    data.update(page=page_no, thumbnail=thumb)
                    data["coverage"]["limitations"] = ["表单动态外观、脚本和交互内容不执行。"]
                    return data, image
            extracted = []
            for index in range(page_no-1, end):
                with contextlib.closing(doc[index]) as page:
                    with contextlib.closing(page.get_textpage()) as textpage:
                        if textpage.count_chars() > MAX_DATA_BYTES:
                            fail("OUTPUT_TOO_LARGE", "单页PDF文本超出返回预算。")
                        text = textpage.get_text_range()
                has_text = bool(text.strip())
                extracted.append({"page": index+1, "text": text, "status": "TEXT_LAYER" if has_text else "NO_EXTRACTABLE_TEXT",
                                  "requiresImageRecognition": not has_text, "coverage": "text_layer_only"})
            data.update(pages=extracted, selection=selection, truncated=end < pages)
            data["coverage"]["limitations"] = ["提取顺序不等于版面阅读顺序；表格结构、图片及批注未提取。", "无文本层不代表空白页，可能需要图像识别。"]
            return data, None
    except MaterialError:
        raise
    except Exception:
        fail("CORRUPT_FILE", "PDF损坏、结构不受支持或无法安全解析。")


class _DiscardText(io.TextIOBase):
    def write(self, value: str) -> int:
        return len(value)


def handle(payload: Any) -> dict:
    """纯内存解析；返回单个协议对象。错误消息不包含源内容或本机路径。"""
    try:
        raw, req = _validate(payload)
        # 库的意外print不能污染协议；不创建日志文件。
        with contextlib.redirect_stdout(_DiscardText()):
            fmt = req["format"]
            image = None
            if fmt == "pdf": data, image = _pdf(raw, req)
            elif fmt == "image": data, image = _image(raw, req)
            elif fmt == "csv": data = _csv(raw, req)
            else:
                pkg = OfficePackage(raw, fmt)
                data = {"xlsx": _xlsx, "docx": _docx, "pptx": _pptx}[fmt](pkg, req)
        data["source"] = {"sha256": hashlib.sha256(raw).hexdigest(), "byteLength": len(raw)}
        data["protocolVersion"] = PROTOCOL_VERSION
        if len(_json_bytes(data)) > MAX_DATA_BYTES:
            fail("OUTPUT_TOO_LARGE", "文本或表格结果超过128 KiB，请缩小读取范围。")
        result = {"ok": True, "data": data}
        if image is not None: result["image"] = image
        if len(_json_bytes(result)) > MAX_STDOUT_BYTES:
            fail("OUTPUT_TOO_LARGE", "结果超过2 MiB输出限制。")
        return result
    except MaterialError as exc:
        return {"ok": False, "error": {"code": exc.code, "message": exc.message}}
    except MemoryError:
        return {"ok": False, "error": {"code": "RESOURCE_LIMIT", "message": "解析超过可用资源限制。"}}
    except Exception:
        return {"ok": False, "error": {"code": "CORRUPT_FILE", "message": "材料结构损坏或包含未支持的内容，未返回伪造结果。"}}


def _unique_object(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result: fail("INVALID_REQUEST", "JSON对象包含重复字段。")
        result[key] = value
    return result


def main() -> int:
    # 协议错误退出2；成功退出0。stdout始终只有一个UTF-8 JSON对象。
    logging.disable(logging.CRITICAL)
    try:
        body = sys.stdin.buffer.read(MAX_STDIN_BYTES+1)
        if len(body) > MAX_STDIN_BYTES:
            fail("INPUT_TOO_LARGE", "stdin超过46 MiB限制。")
        payload = json.loads(body.decode("utf-8", "strict"), object_pairs_hook=_unique_object,
                             parse_constant=lambda _: fail("INVALID_REQUEST", "JSON不得包含非有限数字。"))
        result = handle(payload)
    except MaterialError as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": exc.message}}
    except (ValueError, UnicodeError, RecursionError):
        result = {"ok": False, "error": {"code": "INVALID_JSON", "message": "stdin必须是单个合法UTF-8 JSON。"}}
    sys.stdout.buffer.write(_json_bytes(result)+b"\n")
    sys.stdout.buffer.flush()
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
