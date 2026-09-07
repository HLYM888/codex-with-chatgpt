#!/usr/bin/env python3
"""material_worker的独立合成回归。三文件放同一目录：

python -m unittest -v test_material_worker

仅在临时目录生成合成夹具；无真实数据、Office、Docker或外部网络。
子进程测试只调用本地Python worker/夹具生成器，不调用材料内的命令。
这些测试不代替Node权限、进程收容、MCP原生图片或真实Chat附件往返验收。
依赖不齐时只跳过相应格式测试，跳过数必须在实际回执披露。
"""
from __future__ import annotations

import base64
import codecs
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile
import zlib

import material_worker as worker
import make_material_fixtures as fixtures

HERE = Path(__file__).resolve().parent
DEPS = ("PIL", "pypdf", "pypdfium2", "openpyxl", "docx", "pptx")
HAVE_ALL = all(importlib.util.find_spec(name) is not None for name in DEPS)
CHILD_OPTIONS = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def payload(raw: bytes, fmt: str = "csv", operation: str = "overview", **request) -> dict:
    return {"contentBase64":base64.b64encode(raw).decode("ascii"),
            "request":{"format":fmt,"operation":operation,**request}}


def encoded_response(result: dict) -> bytes:
    return json.dumps(result,ensure_ascii=False,separators=(",",":"),allow_nan=False).encode()


def parts(raw: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        return {name:z.read(name) for name in z.namelist()}


def stored_package(pieces: dict) -> bytes:
    out=io.BytesIO()
    with zipfile.ZipFile(out,"w",compression=zipfile.ZIP_STORED) as z:
        for name,content in pieces.items(): z.writestr(name,content)
    return out.getvalue()


class ProtocolTests(unittest.TestCase):
    def error(self, result: dict, code: str | None = None) -> dict:
        self.assertIs(result["ok"],False,result)
        self.assertEqual(set(result),{"ok","error"})
        if code: self.assertEqual(result["error"]["code"],code,result)
        self.assertNotIn(str(HERE),result["error"]["message"])
        self.assertLessEqual(len(encoded_response(result)),worker.MAX_STDOUT_BYTES)
        return result["error"]

    def test_bad_payloads(self):
        for value in [None,[],{},"text",{"contentBase64":"AA==","request":[],"extra":1}]:
            with self.subTest(value=value): self.error(worker.handle(value),"INVALID_REQUEST")

    def test_base64_strict(self):
        for value in [123,"中","Y Q==","YQ=","YQ===","YR=="]:
            p=payload(b"a");p["contentBase64"]=value
            with self.subTest(value=value): self.error(worker.handle(p),"INVALID_BASE64")

    def test_format_and_operation(self):
        self.error(worker.handle(payload(b"x","xls")),"UNSUPPORTED_FORMAT")
        self.error(worker.handle(payload(b"x","csv","image")),"UNSUPPORTED_OPERATION")

    def test_integer_and_type_validation(self):
        for key,value in [("start",True),("start",0),("count",-1),("count",1.0),("count",51),("range",1)]:
            with self.subTest(key=key,value=value):
                self.error(worker.handle(payload(b"a,b","csv","read",**{key:value})),"INVALID_REQUEST")

    def test_unknown_and_inapplicable_selectors(self):
        p=payload(b"a,b");p["request"]["path"]="/etc/passwd"
        self.error(worker.handle(p),"INVALID_REQUEST")
        self.error(worker.handle(payload(b"a,b", "csv", "overview", page=1)),"INVALID_REQUEST")
        self.error(worker.handle(payload(b"a,b", "csv", "read", range="A1:B1",start=1)),"INVALID_REQUEST")

    def test_raw_file_limit(self):
        with mock.patch.object(worker,"MAX_FILE_BYTES",6):
            self.error(worker.handle(payload(b"1234567")),"FILE_TOO_LARGE")

    def test_source_hash_matches_input(self):
        raw="中文,42\r\n".encode()
        r=worker.handle(payload(raw)); self.assertTrue(r["ok"],r)
        self.assertEqual(r["data"]["source"],{"sha256":hashlib.sha256(raw).hexdigest(),"byteLength":len(raw)})

    def test_return_data_budget(self):
        raw=b"a"*90000+b","+b"b"*50000
        self.error(worker.handle(payload(raw,"csv","read")),"OUTPUT_TOO_LARGE")

    def test_escaped_utf8_budget(self):
        raw=("中"*30000+","+"\""+"\\"*30000+"\"").encode()
        self.error(worker.handle(payload(raw,"csv","read")),"OUTPUT_TOO_LARGE")

    def test_total_stdout_budget(self):
        with mock.patch.object(worker,"MAX_STDOUT_BYTES",128):
            self.error(worker.handle(payload(b"a,b")),"OUTPUT_TOO_LARGE")

    def test_accidental_library_print_is_not_protocol(self):
        def loud(*args):
            print("LIBRARY_NOISE")
            return {"note":"ok"},None
        output=io.StringIO()
        with mock.patch.object(worker,"_image",loud),contextlib.redirect_stdout(output):
            result=worker.handle(payload(b"x","image"))
        self.assertTrue(result["ok"]);self.assertEqual(output.getvalue(),"")

    def test_unhandled_exception_hides_path(self):
        with mock.patch.object(worker,"_csv",side_effect=OSError("/secret/project/api-key")):
            r=worker.handle(payload(b"a"))
        self.error(r,"CORRUPT_FILE");self.assertNotIn("secret",json.dumps(r))

    def cli(self, raw: bytes) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable,str(HERE/"material_worker.py")],input=raw,capture_output=True,timeout=15,check=False,**CHILD_OPTIONS)

    def test_cli_single_utf8_json_success(self):
        p=payload("中文,42".encode(),"csv","read")
        r=self.cli(json.dumps(p).encode()); self.assertEqual(r.returncode,0,r.stderr)
        output=json.loads(r.stdout.decode("utf-8"));self.assertTrue(output["ok"])
        self.assertEqual(r.stdout.count(b"\n"),1)
        self.assertEqual(r.stderr,b"")

    def test_cli_invalid_jsons(self):
        for raw in [b"{}{}",b"\xff",b'{"contentBase64":"","contentBase64":"","request":{}}',b'{"x":NaN}']:
            with self.subTest(raw=raw):
                r=self.cli(raw);self.assertEqual(r.returncode,2);self.error(json.loads(r.stdout))

    def test_stdin_budget_bounded_read(self):
        fake_in=type("Input",(),{"buffer":io.BytesIO(b"x"*33)})()
        out=io.BytesIO();fake_out=type("Output",(),{"buffer":out})()
        with mock.patch.object(worker,"MAX_STDIN_BYTES",32),mock.patch.object(worker.sys,"stdin",fake_in),mock.patch.object(worker.sys,"stdout",fake_out):
            code=worker.main()
        self.assertEqual(code,2);self.error(json.loads(out.getvalue()),"INPUT_TOO_LARGE")


class CsvTests(unittest.TestCase):
    error=ProtocolTests.error

    def test_csv_multiline_and_empty_vs_missing(self):
        raw='a,b,c\r\n中,,"x\ny"\r\n短,2\r\n'.encode()
        r=worker.handle(payload(raw,"csv","read",range="A1:C3"));self.assertTrue(r["ok"],r)
        rows=r["data"]["rows"]
        self.assertEqual(rows[1]["cells"][1]["value"],"")
        self.assertEqual(rows[2]["cells"][2]["type"],"missing")
        self.assertEqual(rows[1]["physicalLines"],{"start":2,"end":3})
        self.assertEqual(rows[1]["cells"][2]["value"],"x\ny")

    def test_csv_strict_gbk(self):
        raw="名称,值\r\n中文,42".encode("gbk")
        self.error(worker.handle(payload(raw)),"INVALID_ENCODING")
        r=worker.handle(payload(raw,"csv","read",encoding="gbk"));self.assertTrue(r["ok"])
        self.assertEqual(r["data"]["rows"][1]["cells"][0]["value"],"中文")

    def test_csv_utf16_and_bom(self):
        for enc,bom in [("utf-16-le",codecs.BOM_UTF16_LE),("utf-16-be",codecs.BOM_UTF16_BE)]:
            with self.subTest(enc=enc):
                raw=bom+"名称,值\n中文,42".encode(enc)
                r=worker.handle(payload(raw,"csv","read",encoding="utf16"));self.assertTrue(r["ok"],r)
                self.assertEqual(r["data"]["rows"][1]["cells"][0]["value"],"中文")
        self.error(worker.handle(payload(codecs.BOM_UTF16_LE+b"a\0",encoding="utf8")),"ENCODING_CONFLICT")
        self.error(worker.handle(payload(codecs.BOM_UTF8*2+b"a,b")),"ENCODING_CONFLICT")
        self.error(worker.handle(payload(b"a\0",encoding="utf16")),"ENCODING_REQUIRED")

    def test_csv_out_of_range(self):
        self.error(worker.handle(payload(b"a,b","csv","read",start=2)),"RANGE_NOT_FOUND")
        self.error(worker.handle(payload(b"a,b","csv","read",range="A1:B2")),"RANGE_NOT_FOUND")

    def test_csv_formula_is_text(self):
        r=worker.handle(payload(b"=2+2","csv","read"));self.assertTrue(r["ok"])
        self.assertEqual(r["data"]["rows"][0]["cells"][0]["value"],"=2+2")

    def test_csv_empty_and_corrupt(self):
        self.assertEqual(worker.handle(payload(b""))["data"]["rowCount"],0)
        self.error(worker.handle(payload(b"","csv","read")),"RANGE_NOT_FOUND")
        self.error(worker.handle(payload(b'a,"unterminated',"csv","read")),"INVALID_CSV")
        self.error(worker.handle(payload(b"x"*300000,"csv","read")),"INVALID_CSV")
        self.error(worker.handle(payload(b"a\0b")),"FORMAT_MISMATCH")

    def test_csv_range_and_pagination(self):
        raw="\n".join("a,b" for _ in range(30)).encode()
        r=worker.handle(payload(raw,"csv","read",start=3,count=2))
        self.assertEqual(r["data"]["selection"]["nextStart"],5)
        self.assertEqual([x["row"] for x in r["data"]["rows"]],[3,4])
        self.error(worker.handle(payload(raw,"csv","read",range="A1:Z30")),"RANGE_LIMIT")


@unittest.skipUnless(HAVE_ALL,"缺少格式依赖；安装依赖后必须实际执行，不将跳过记为通过")
class FormatTests(unittest.TestCase):
    error=ProtocolTests.error
    @classmethod
    def setUpClass(cls):
        cls.files, cls.answers=fixtures.build_fixture_bytes()

    def read(self,name,fmt,op="read",**req):
        return worker.handle(payload(self.files[name],fmt,op,**req))

    def success(self,result):
        self.assertTrue(result["ok"],result)
        self.assertLessEqual(len(encoded_response(result["data"])),worker.MAX_DATA_BYTES)
        self.assertLessEqual(len(encoded_response(result)),worker.MAX_STDOUT_BYTES)
        return result["data"]

    def test_pdf_overview(self):
        d=self.success(self.read("sample.pdf","pdf","overview"))
        self.assertEqual(d["pageCount"],2);self.assertEqual(len(d["outline"]),2)
        self.assertEqual(d["outline"][0]["page"],1)

    def test_pdf_text_and_scanned_page(self):
        d=self.success(self.read("sample.pdf","pdf",page=1,count=2))
        self.assertIn("Material fixture",d["pages"][0]["text"])
        self.assertIn("中文文本",d["pages"][0]["text"])
        self.assertEqual(d["pages"][1]["status"],"NO_EXTRACTABLE_TEXT")
        self.assertTrue(d["pages"][1]["requiresImageRecognition"])
        self.assertNotIn(self.answers["visualDigits"],json.dumps(d,ensure_ascii=False))

    def test_pdf_page_image(self):
        from PIL import Image
        r=self.read("sample.pdf","pdf","image",page=2);d=self.success(r)
        binary=base64.b64decode(r["image"]["data"],validate=True)
        self.assertLessEqual(len(binary),worker.MAX_IMAGE_BYTES)
        with Image.open(io.BytesIO(binary)) as im:
            self.assertLessEqual(max(im.size),1600);self.assertGreater(min(im.size),1)
        self.assertEqual(d["page"],2)

    def test_pdf_errors(self):
        self.error(self.read("encrypted.pdf","pdf","overview"),"ENCRYPTED_FILE")
        self.error(self.read("encrypted.pdf","pdf","image"),"ENCRYPTED_FILE")
        self.error(self.read("broken.pdf","pdf","overview"),"CORRUPT_FILE")
        self.error(self.read("sample.pdf","pdf",page=3),"RANGE_NOT_FOUND")
        self.error(self.read("sample.pdf","pdf",count=6),"INVALID_REQUEST")
        self.error(self.read("visual.png","pdf","overview"),"FORMAT_MISMATCH")

    def test_xlsx_overview_ignores_forged_dimension(self):
        d=self.success(self.read("forged-dimension.xlsx","xlsx","overview"))
        s=d["sheets"][0]
        self.assertEqual(s["declaredRange"],"A1:XFD1048576")
        self.assertEqual(s["observedRange"],"A1:F7")
        self.assertFalse(s["declaredRangeTrustedForIteration"])
        self.assertEqual(d["sheets"][1]["state"],"hidden")

    def test_xlsx_cells_formula_cache_blank(self):
        d=self.success(self.read("sample.xlsx","xlsx",sheet="Sheet1",range="A1:F7"))
        cells={x["address"]:x for x in d["cells"]}
        self.assertEqual(cells["C2"]["formula"],"=B2*2")
        self.assertEqual(cells["C2"]["cachedValue"],6);self.assertTrue(cells["C2"]["cachePresent"])
        self.assertFalse(cells["C3"]["cachePresent"]);self.assertIsNone(cells["C3"]["cachedValue"])
        self.assertEqual(cells["D2"]["value"],"");self.assertEqual(cells["D2"]["type"],"string")
        self.assertFalse(cells["D3"]["present"]);self.assertEqual(cells["E3"]["type"],"blank")
        self.assertTrue(cells["E3"]["present"]);self.assertEqual(cells["D4"]["value"],"  ")
        self.assertEqual(cells["A3"]["value"],"共享中文")
        self.assertEqual(cells["A5"]["type"],"string")
        self.assertEqual(cells["F4"]["value"],"#DIV/0!")

    def test_xlsx_dates_and_shared_formula(self):
        d=self.success(self.read("sample.xlsx","xlsx",sheet="Sheet1",range="C2:F6"))
        cells={x["address"]:x for x in d["cells"]}
        self.assertTrue(cells["E2"]["value"]["iso8601"].startswith("2026-09-08"))
        self.assertEqual(cells["E4"]["type"],"excel1900LeapDay")
        self.assertIsNone(cells["E4"]["value"]["iso8601"])
        self.assertEqual(cells["E5"]["type"],"time")
        self.assertEqual(cells["C6"]["formula"],"=B3*2")
        self.assertEqual(cells["C6"]["cachedValue"],8)

    def test_xlsx_errors(self):
        self.error(self.read("sample.xlsx","xlsx"),"INVALID_REQUEST")
        self.error(self.read("sample.xlsx","xlsx",sheet="不存在",range="A1"),"SHEET_NOT_FOUND")
        for rng,code in [("A0","INVALID_RANGE"),("XFE1","INVALID_RANGE"),("A1:A1048577","INVALID_RANGE"),("B2:A1","INVALID_RANGE"),("A1:A501","RANGE_LIMIT")]:
            with self.subTest(rng=rng):self.error(self.read("sample.xlsx","xlsx",sheet="Sheet1",range=rng),code)

    def test_xlsx_500_grid_positions_not_dimension_iteration(self):
        d=self.success(self.read("forged-dimension.xlsx","xlsx",sheet="Sheet1",range="A1048000:A1048499"))
        self.assertEqual(d["cellCount"],500)
        self.assertTrue(all(not c["present"] for c in d["cells"]))

    def test_docx_order_and_overview(self):
        d=self.success(self.read("sample.docx","docx"))
        self.assertEqual([b["type"] for b in d["blocks"]],["paragraph","paragraph","table","paragraph","paragraph"])
        self.assertIn("中文",d["blocks"][1]["text"])
        self.assertEqual(d["blocks"][2]["rows"][1]["cells"][1]["text"],"42")
        self.assertIsNone(d["pageCount"])
        self.assertNotIn("页眉：不属于正文",json.dumps(d,ensure_ascii=False))
        self.assertTrue(d["blocks"][4]["imagesExcluded"])
        overview=self.success(self.read("sample.docx","docx","overview",start=2,count=2))
        self.assertEqual(overview["selection"]["nextStart"],4)
        self.assertEqual(overview["paragraphCount"],4);self.assertEqual(overview["tableCount"],1)

    def test_docx_slice_errors(self):
        d=self.success(self.read("sample.docx","docx",start=3,count=1))
        self.assertEqual(d["blocks"][0]["tableIndex"],1)
        self.error(self.read("sample.docx","docx",start=999),"RANGE_NOT_FOUND")
        self.error(self.read("sample.docx","docx",count=51),"INVALID_REQUEST")

    def test_docx_table_bound(self):
        p=parts(self.files["sample.docx"])
        ns=worker.W
        cells="".join('<w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc>' for _ in range(501))
        p["word/document.xml"]=f'<w:document xmlns:w="{ns}"><w:body><w:tbl><w:tr>{cells}</w:tr></w:tbl></w:body></w:document>'
        r=worker.handle(payload(stored_package(p),"docx","read"))
        self.error(r,"TABLE_LIMIT")

    def test_pptx_order_and_tables(self):
        d=self.success(self.read("sample.pptx","pptx",page=1,count=2))
        self.assertEqual(d["slideCount"],2)
        self.assertIn("中文",d["slides"][0]["title"])
        table=next(s for s in d["slides"][0]["shapes"] if s["type"]=="table")
        self.assertEqual(table["rows"][1]["cells"][1]["text"],"42")
        self.assertNotIn(self.answers["visualDigits"],json.dumps(d,ensure_ascii=False))
        overview=self.success(self.read("sample.pptx","pptx","overview",count=1))
        self.assertEqual(overview["selection"]["nextStart"],2)
        self.error(self.read("sample.pptx","pptx",page=3),"RANGE_NOT_FOUND")

    def test_images_overview_and_thumbnails(self):
        from PIL import Image
        for suffix,mime in [("png","image/png"),("jpg","image/jpeg"),("webp","image/webp")]:
            with self.subTest(suffix=suffix):
                d=self.success(self.read("visual."+suffix,"image","overview"))
                self.assertEqual(d["mimeType"],mime);self.assertEqual(d["width"],1800)
                r=self.read("visual."+suffix,"image","image");self.success(r)
                with Image.open(io.BytesIO(base64.b64decode(r["image"]["data"]))) as im:
                    self.assertLessEqual(max(im.size),1600);self.assertFalse(im.info)

    def test_image_bomb_and_corruption(self):
        self.error(worker.handle(payload(self.files["visual.png"][:60],"image","image")),"CORRUPT_FILE")
        raw=bytearray(self.files["visual.png"])
        raw[16:24]=struct.pack(">II",100000,100000)
        raw[29:33]=struct.pack(">I",zlib.crc32(raw[12:29]) & 0xffffffff)
        self.error(worker.handle(payload(bytes(raw),"image","overview")),"IMAGE_LIMIT")

    def test_image_noise_stays_within_binary_budget(self):
        from PIL import Image
        with Image.frombytes("RGB",(1600,1600),os.urandom(1600*1600*3)) as img:
            out=io.BytesIO();img.save(out,"PNG")
        r=worker.handle(payload(out.getvalue(),"image","image"));self.success(r)
        self.assertLessEqual(len(base64.b64decode(r["image"]["data"])),worker.MAX_IMAGE_BYTES)
        self.assertLess(r["data"]["thumbnail"]["width"],1600)

    def test_sources_never_change(self):
        before={n:hashlib.sha256(b).hexdigest() for n,b in self.files.items()}
        for name,fmt in [("sample.pdf","pdf"),("sample.xlsx","xlsx"),("sample.docx","docx"),("sample.pptx","pptx"),("visual.png","image")]:
            self.success(self.read(name,fmt,"overview"))
        self.assertEqual(before,{n:hashlib.sha256(b).hexdigest() for n,b in self.files.items()})

    def test_no_python_network_or_command_calls_in_parsing(self):
        import socket
        with mock.patch.object(socket.socket,"connect",side_effect=AssertionError("network forbidden")),mock.patch.object(subprocess,"Popen",side_effect=AssertionError("command forbidden")):
            for name,fmt in [("sample.pdf","pdf"),("sample.xlsx","xlsx"),("sample.docx","docx"),("sample.pptx","pptx"),("visual.png","image")]:
                self.success(self.read(name,fmt,"overview"))

    def test_office_disguise_macro_dtd(self):
        self.error(self.read("sample.xlsx","docx","overview"),"FORMAT_MISMATCH")
        self.error(self.read("disguised.xlsx","xlsx","overview"),"FORMAT_MISMATCH")
        self.error(self.read("unsafe-macro.docx","docx","overview"),"ACTIVE_CONTENT")
        self.error(self.read("unsafe-dtd.docx","docx","overview"),"UNSAFE_XML")

    def test_xml_utf16_dtd_rejected(self):
        raw=fixtures.replace_zip_part(self.files["sample.docx"],"word/document.xml",'<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE root [<!ENTITY x "hello">]><root>&x;</root>'.encode("utf-16"))
        self.error(worker.handle(payload(raw,"docx","overview")),"UNSAFE_XML")

    def test_xml_depth_and_malformed(self):
        for text,code in [("<x>"*65+"</x>"*65,"XML_LIMIT"),("<broken>","INVALID_XML")]:
            raw=fixtures.replace_zip_part(self.files["sample.docx"],"word/document.xml",text)
            self.error(worker.handle(payload(raw,"docx","overview")),code)

    def test_zip_path_duplicates_and_symlink(self):
        p=parts(self.files["sample.docx"])
        for name in ["../escape","/absolute","word\\escape", "word/../escape", "word\x00escape"]:
            with self.subTest(name=name):
                wire_name = name.replace("\\", "_").replace("\x00", "_")
                p2=dict(p);p2[wire_name]=b"test"
                raw = fixtures.repack(p2)
                if wire_name != name:
                    # Windows ZipInfo normalizes separators when creating a ZIP.
                    # Rewrite both equal-length header names, leaving CRC/data intact.
                    self.assertEqual(raw.count(wire_name.encode()), 2)
                    raw = raw.replace(wire_name.encode(), name.encode())
                    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                        self.assertIn(name, [entry.orig_filename for entry in archive.infolist()])
                self.error(worker.handle(payload(raw,"docx","overview")),"UNSAFE_ZIP")
        out=io.BytesIO()
        with zipfile.ZipFile(out,"w") as z:
            for name,data in p.items():z.writestr(name,data)
            info=zipfile.ZipInfo("symlink");info.create_system=3;info.external_attr=(0o120777<<16)
            z.writestr(info,b"/elsewhere")
        self.error(worker.handle(payload(out.getvalue(),"docx","overview")),"UNSAFE_ZIP")
        p["WORD/DOCUMENT.XML"]=p["word/document.xml"]
        self.error(worker.handle(payload(fixtures.repack(p),"docx","overview")),"UNSAFE_ZIP")

    def test_zip_limits(self):
        for attr,value in [("MAX_ZIP_ENTRIES",2),("MAX_ZIP_TOTAL",100),("MAX_ZIP_ENTRY",100),("MAX_COMPRESSION_RATIO",1)]:
            with self.subTest(attr=attr),mock.patch.object(worker,attr,value):
                self.error(self.read("sample.docx","docx","overview"),"ZIP_LIMIT")

    def test_zip_encryption_flag(self):
        raw=bytearray(self.files["sample.docx"])
        pos=raw.index(b"PK\x01\x02")
        flags=struct.unpack_from("<H",raw,pos+8)[0];struct.pack_into("<H",raw,pos+8,flags|1)
        self.error(worker.handle(payload(bytes(raw),"docx","overview")),"ENCRYPTED_FILE")

    def test_office_external_link_not_followed(self):
        p=parts(self.files["sample.docx"])
        name="word/_rels/document.xml.rels"
        text=p[name].decode().replace("</Relationships>",'<Relationship Id="fixtureExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://invalid.example/never-request" TargetMode="External"/></Relationships>')
        p[name]=text
        r=worker.handle(payload(fixtures.repack(p),"docx","overview"));self.success(r)
        self.assertEqual(r["data"]["externalLinksIgnored"],1)
        self.assertNotIn("https://invalid.example",json.dumps(r))

    def test_macro_content_type_rejected(self):
        p=parts(self.files["sample.xlsx"])
        p["[Content_Types].xml"]=p["[Content_Types].xml"].replace(worker.MAIN_TYPE["xlsx"].encode(),b"application/vnd.ms-excel.sheet.macroEnabled.main+xml")
        self.error(worker.handle(payload(fixtures.repack(p),"xlsx","overview")),"ACTIVE_CONTENT")

    def test_cli_all_formats_native_json(self):
        cases = [("sample.pdf", "pdf", "read", {"page": 1, "count": 2}),
                 ("sample.xlsx", "xlsx", "read", {"sheet": "Sheet1", "range": "A1:F7"}),
                 ("sample.docx", "docx", "read", {}),
                 ("sample.pptx", "pptx", "read", {}),
                 ("visual.png", "image", "image", {}),
                 ("sample-gbk.csv", "csv", "read", {"encoding": "gbk"})]
        for name, fmt, op, extra in cases:
            with self.subTest(format=fmt):
                result = subprocess.run(
                    [sys.executable, str(HERE / "material_worker.py")],
                    input=json.dumps(payload(self.files[name], fmt, op, **extra)).encode(),
                    capture_output=True, timeout=15, check=False, **CHILD_OPTIONS)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.success(json.loads(result.stdout.decode("utf-8")))
                self.assertEqual(result.stdout.count(b"\n"), 1)
                self.assertEqual(result.stderr, b"")

    def test_xlsx_string_formula_empty_cache(self):
        p = parts(self.files["sample.xlsx"])
        text = p["xl/worksheets/sheet1.xml"].decode()
        text = text.replace('<c r="C3"><f>B3*2</f></c>',
                            '<c r="C3" t="str"><f>IF(B3,\"\",\"x\")</f><v/></c>')
        p["xl/worksheets/sheet1.xml"] = text
        r = worker.handle(payload(fixtures.repack(p), "xlsx", "read", sheet="Sheet1", range="C3"))
        d = self.success(r)
        self.assertTrue(d["cells"][0]["cachePresent"])
        self.assertEqual(d["cells"][0]["cachedValue"], "")
        self.assertEqual(d["cells"][0]["cachedType"], "string")

    def test_xlsx_1904_epoch(self):
        p = parts(self.files["sample.xlsx"])
        p["xl/workbook.xml"] = p["xl/workbook.xml"].replace(b'date1904="0"', b'date1904="1"')
        d = self.success(worker.handle(payload(fixtures.repack(p), "xlsx", "read", sheet="Sheet1", range="E4")))
        self.assertEqual(d["dateSystem"], "1904")
        self.assertEqual(d["cells"][0]["type"], "datetime")
        self.assertTrue(d["cells"][0]["value"]["iso8601"].startswith("1904-03-01"))

    def test_xlsx_nonfinite_and_bad_shared_formula(self):
        for before, after in [(b'<v>3</v>', b'<v>NaN</v>'),
                              (b'<f t="shared" si="0"/>', b'<f t="shared" si="99"/>')]:
            p = parts(self.files["sample.xlsx"])
            p["xl/worksheets/sheet1.xml"] = p["xl/worksheets/sheet1.xml"].replace(before, after, 1)
            self.error(worker.handle(payload(fixtures.repack(p), "xlsx", "read", sheet="Sheet1", range="A1:F7")))

    def test_docx_partial_coverage_is_explicit(self):
        p = parts(self.files["sample.docx"])
        raw = p["word/document.xml"]
        raw = raw.replace(b"<w:body>", b'<w:body><w:sdt><w:sdtContent><w:p><w:r><w:t>excluded</w:t></w:r></w:p></w:sdtContent></w:sdt>', 1)
        p["word/document.xml"] = raw
        d = self.success(worker.handle(payload(fixtures.repack(p), "docx", "read", start=1, count=1)))
        self.assertEqual(d["blocks"][0]["type"], "unsupported")
        self.assertFalse(d["coverage"]["completeForSelection"])
        self.assertEqual(d["selection"]["nextStart"], 2)

    def test_image_gif_disguise_rejected(self):
        from PIL import Image
        out = io.BytesIO()
        Image.new("RGB", (10,10)).save(out, "GIF")
        self.error(worker.handle(payload(out.getvalue(), "image", "image")), "FORMAT_MISMATCH")

    def test_zip_crc_corruption_rejected(self):
        raw = bytearray(stored_package(parts(self.files["sample.xlsx"])))
        offset = raw.index(b"date1904")
        raw[offset] = ord("X")
        self.error(worker.handle(payload(bytes(raw), "xlsx", "overview")), "CORRUPT_FILE")

    def test_internal_relationship_escape_rejected(self):
        p = parts(self.files["sample.xlsx"])
        p["xl/_rels/workbook.xml.rels"] = p["xl/_rels/workbook.xml.rels"].replace(
            b'Target="worksheets/sheet1.xml"', b'Target="../../outside.xml"')
        self.error(worker.handle(payload(fixtures.repack(p), "xlsx", "overview")), "UNSAFE_ZIP")

    def test_pdf_outline_limit_is_explicit(self):
        from pypdf import PdfWriter
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        for index in range(105): writer.add_outline_item(f"chapter-{index}", 0)
        buf = io.BytesIO(); writer.write(buf); writer.close()
        d = self.success(worker.handle(payload(buf.getvalue(), "pdf", "overview")))
        self.assertEqual(len(d["outline"]), 100)
        self.assertTrue(d["truncated"])
        self.assertFalse(d["coverage"]["completeForSelection"])

    def test_fixture_generator_refuses_overwrite(self):
        with tempfile.TemporaryDirectory(prefix="material-fixtures-test-") as temp:
            target=Path(temp)/"owned"
            report=fixtures.make_fixtures(target)
            self.assertGreaterEqual(len(report["files"]),12)
            before={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in target.iterdir()}
            with self.assertRaises(FileExistsError):fixtures.make_fixtures(target)
            self.assertEqual(before,{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in target.iterdir()})


if __name__ == "__main__":
    unittest.main(verbosity=2)
