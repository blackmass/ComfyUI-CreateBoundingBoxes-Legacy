"""
Create Bounding Boxes (for node 1.0)

ComfyUI core 의 `CreateBoundingBoxes` (comfy_extras/nodes_bounding_boxes.py) 와
동일한 입출력/로직을 node 1.0(LiteGraph) 프론트엔드에서 쓸 수 있게 만든 독립 커스텀 노드입니다.

* node id  : CreateBoundingBoxesLegacy   (코어의 "CreateBoundingBoxes" 와 id 가 달라 서로 간섭하지 않음)
* 코어 모듈(comfy_extras.*, comfy_api.latest)에 의존하지 않음 -> 코어가 바뀌어도 영향 없음
"""

import json
import os
import re

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageEnhance, ImageFont

try:
    import folder_paths
except Exception:  # 단독 테스트용
    folder_paths = None

_PREVIEW_LONG_EDGE = 1024
_PREVIEW_DIM = 0.25
_BG_ECHO_LONG_EDGE = 1024
_HEX_CHARS = set("0123456789abcdefABCDEF")


# --------------------------------------------------------------------------- #
# color helpers (코어의 color_util 대체)
# --------------------------------------------------------------------------- #
def normalize_palette(palette) -> list:
    out = []
    if not isinstance(palette, (list, tuple)):
        return out
    for c in palette:
        if not isinstance(c, str):
            continue
        s = c.strip().lstrip("#")
        if len(s) == 3:
            s = "".join(ch * 2 for ch in s)
        if len(s) != 6 or any(ch not in _HEX_CHARS for ch in s):
            continue
        out.append("#" + s.upper())
    return out


def hex_to_rgb(value, fallback=(140, 140, 140)):
    try:
        s = str(value).strip().lstrip("#")
        if len(s) == 3:
            s = "".join(ch * 2 for ch in s)
        return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    except Exception:
        return fallback


def readable_color(rgb):
    """어두운 배경 위에서 읽기 쉽도록 색을 흰색 쪽으로 섞는다."""
    r, g, b = rgb
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    t = 0.35 if lum > 140 else 0.7
    return tuple(int(round(c + (255 - c) * t)) for c in (r, g, b))


# --------------------------------------------------------------------------- #
# geometry helpers (코어 로직 이식)
# --------------------------------------------------------------------------- #
def pixels_to_fractions(box: dict, width: int, height: int) -> dict:
    w = width or 1
    h = height or 1
    return {
        "x": box.get("x", 0) / w,
        "y": box.get("y", 0) / h,
        "w": box.get("width", 0) / w,
        "h": box.get("height", 0) / h,
    }


def fractions_to_pixels(box: dict, width: int, height: int) -> dict:
    x, y = box.get("x", 0.0), box.get("y", 0.0)
    w, h = box.get("w", 0.0), box.get("h", 0.0)
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    return {
        "x": round(x * width),
        "y": round(y * height),
        "width": round(w * width),
        "height": round(h * height),
    }


def fractions_to_bbox_frame(boxes: list, width: int, height: int) -> list:
    pixels = [
        fractions_to_pixels(box, width, height)
        for box in boxes
        if isinstance(box, dict)
    ]
    return [pixels] if pixels else []


def boxes_to_regions(boxes, width: int, height: int) -> list:
    regions: list = []
    if not isinstance(boxes, list):
        return regions
    for box in boxes:
        if not isinstance(box, dict):
            continue
        meta = box.get("metadata")
        meta = meta if isinstance(meta, dict) else {}
        regions.append({
            **pixels_to_fractions(box, width, height),
            "type": meta.get("type", "obj"),
            "text": meta.get("text", ""),
            "desc": meta.get("desc", ""),
            "palette": normalize_palette(meta.get("palette", [])),
        })
    return regions


def normalize_incoming_boxes(bboxes) -> list:
    if isinstance(bboxes, dict):
        frame = [bboxes]
    elif not isinstance(bboxes, list) or not bboxes:
        frame = []
    elif isinstance(bboxes[0], dict):
        frame = bboxes
    else:
        # BOUNDING_BOX 는 프레임별 리스트: 첫 프레임만 사용 (코어와 동일)
        frame = bboxes[0] if isinstance(bboxes[0], list) else []

    boxes = []
    for box in frame:
        if not isinstance(box, dict):
            continue
        norm = {
            "x": box.get("x", 0),
            "y": box.get("y", 0),
            "width": box.get("width", 0),
            "height": box.get("height", 0),
        }
        meta = box.get("metadata")
        if isinstance(meta, dict):
            norm["metadata"] = meta
        boxes.append(norm)
    return boxes


def _looks_like_element(box: dict) -> bool:
    bbox = box.get("bbox")
    return isinstance(bbox, (list, tuple)) and len(bbox) == 4


def _looks_like_bbox(box: dict) -> bool:
    return all(key in box for key in ("x", "y", "width", "height"))


def elements_to_boxes(elements: list, width: int, height: int) -> list:
    boxes = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        bbox = element.get("bbox")
        if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
            raise ValueError("bboxes element is missing a valid 'bbox' [ymin, xmin, ymax, xmax]")
        try:
            ymin, xmin, ymax, xmax = (float(v) / 1000.0 for v in bbox)
        except (TypeError, ValueError):
            raise ValueError("bboxes element 'bbox' must contain four numbers")
        etype = "text" if element.get("type") == "text" else "obj"
        boxes.append({
            "x": round(min(xmin, xmax) * width),
            "y": round(min(ymin, ymax) * height),
            "width": round(abs(xmax - xmin) * width),
            "height": round(abs(ymax - ymin) * height),
            "metadata": {
                "type": etype,
                "text": element.get("text", "") if etype == "text" else "",
                "desc": element.get("desc", ""),
                "palette": element.get("color_palette", []) or [],
            },
        })
    return boxes


def boxes_from_input(data, width: int, height: int) -> list:
    if data is None:
        return []
    if isinstance(data, str):
        text = data.strip()
        if not text:
            return []
        try:
            data = json.loads(text)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"bboxes string input is not valid JSON: {exc}") from exc

    if isinstance(data, dict):
        if _looks_like_element(data):
            return elements_to_boxes([data], width, height)
        if _looks_like_bbox(data):
            return normalize_incoming_boxes(data)
        raise ValueError(
            "bboxes dict must be a bounding box (x, y, width, height) or an element (with a 'bbox')"
        )

    if not isinstance(data, list):
        raise ValueError(
            "bboxes input must be bounding boxes, elements, or a JSON string, "
            f"got {type(data).__name__}"
        )
    if not data:
        return []

    first = data[0]
    if isinstance(first, list):
        return normalize_incoming_boxes(data)
    if isinstance(first, dict):
        if _looks_like_element(first):
            return elements_to_boxes(data, width, height)
        if _looks_like_bbox(first):
            return normalize_incoming_boxes(data)
        raise ValueError(
            "bboxes items must be bounding boxes (x, y, width, height) or elements (with a 'bbox')"
        )
    raise ValueError(
        f"bboxes list must contain bounding boxes or elements, got {type(first).__name__}"
    )


def _norm_bbox(region: dict) -> list:
    def grid(value: float) -> int:
        return max(0, min(1000, round(value * 1000)))

    x, y = region.get("x", 0.0), region.get("y", 0.0)
    w, h = region.get("w", 0.0), region.get("h", 0.0)
    ymin, xmin, ymax, xmax = grid(y), grid(x), grid(y + h), grid(x + w)
    if ymin > ymax:
        ymin, ymax = ymax, ymin
    if xmin > xmax:
        xmin, xmax = xmax, xmin
    return [ymin, xmin, ymax, xmax]


def build_elements(regions: list) -> list:
    elements = []
    for region in regions:
        if not isinstance(region, dict):
            continue
        etype = "text" if region.get("type") == "text" else "obj"
        element = {"type": etype}
        element["bbox"] = _norm_bbox(region)
        if etype == "text":
            element["text"] = region.get("text", "")
        element["desc"] = region.get("desc", "")
        palette = normalize_palette(region.get("palette", []))
        if palette:
            element["color_palette"] = palette[:5]
        elements.append(element)
    return elements


# --------------------------------------------------------------------------- #
# preview rendering
# --------------------------------------------------------------------------- #
def _font(size: int):
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def _wrap(draw, text: str, font, max_w: float) -> list:
    lines = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            test = word if not line else line + " " + word
            if line and draw.textlength(test, font=font) > max_w:
                lines.append(line)
                line = word
            else:
                line = test
        lines.append(line)
    return lines


def _bg_from_image(image):
    if image is None:
        return None
    try:
        arr = (image[0].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
        if arr.ndim == 3 and arr.shape[2] > 3:
            arr = arr[:, :, :3]
        return Image.fromarray(arr)
    except Exception:
        return None


def render_preview(regions, width, height, bg=None):
    if bg is not None:
        iw, ih = bg.size
        long_edge = max(iw, ih) or 1
        scale = min(1.0, _PREVIEW_LONG_EDGE / long_edge)
        rw, rh = max(1, round(iw * scale)), max(1, round(ih * scale))
        base = bg.convert("RGB").resize((rw, rh), Image.LANCZOS)
        base = ImageEnhance.Brightness(base).enhance(_PREVIEW_DIM)
        img = base.convert("RGBA")
    else:
        long_edge = max(width, height) or 1
        scale = min(1.0, _PREVIEW_LONG_EDGE / long_edge)
        rw, rh = max(1, round(width * scale)), max(1, round(height * scale))
        grey = round(_PREVIEW_DIM * 128)
        img = Image.new("RGBA", (rw, rh), (grey, grey, grey, 255))

    overlay = Image.new("RGBA", (rw, rh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fs = max(10, round(rh / 64))
    font = _font(fs)
    tag_font = _font(max(9, fs - 2))
    line_h = fs + 2

    for i, region in enumerate(regions):
        if not isinstance(region, dict):
            continue
        palette = [c for c in (region.get("palette") or []) if c]
        r, g, b = hex_to_rgb(palette[0]) if palette else (140, 140, 140)

        x1 = max(0, min(rw, round(region.get("x", 0) * rw)))
        y1 = max(0, min(rh, round(region.get("y", 0) * rh)))
        x2 = max(0, min(rw, round((region.get("x", 0) + region.get("w", 0)) * rw)))
        y2 = max(0, min(rh, round((region.get("y", 0) + region.get("h", 0)) * rh)))
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1

        draw.rectangle([x1, y1, x2, y2], outline=(r, g, b, 255), width=2)

        swatches = palette[:5]
        if swatches and (x2 - x1) > 2:
            sh = max(5, fs // 2)
            seg = (x2 - x1) / len(swatches)
            for p, hexc in enumerate(swatches):
                sx = x1 + round(p * seg)
                draw.rectangle([sx, y1, x1 + round((p + 1) * seg), y1 + sh], fill=hex_to_rgb(hexc))

        etype = "text" if region.get("type") == "text" else "obj"
        tag = str(i + 1).zfill(2)
        tw = draw.textlength(tag, font=tag_font)
        draw.rectangle([x1, y1, x1 + tw + 6, y1 + fs + 2], fill=(r, g, b, 255))
        tag_fill = (0, 0, 0, 255) if (0.299 * r + 0.587 * g + 0.114 * b) > 140 else (255, 255, 255, 255)
        draw.text((x1 + 3, y1 + 1), tag, fill=tag_fill, font=tag_font)

        body = region.get("desc", "") or ""
        if etype == "text" and region.get("text"):
            body = '"%s"%s' % (region["text"], " — " + body if body else "")
        if body and (x2 - x1) > 8:
            ty = y1 + fs + 5
            for line in _wrap(draw, body, font, x2 - x1 - 8):
                if ty > y2:
                    break
                draw.text((x1 + 4, ty), line, fill=readable_color((r, g, b)) + (255,), font=font)
                ty += line_h

    composed = Image.alpha_composite(img, overlay).convert("RGB")
    arr = np.asarray(composed, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


# --------------------------------------------------------------------------- #
# frontend 로 배경 이미지를 전달 (캔버스 에디터용)
# --------------------------------------------------------------------------- #
def _echo_background(pil_bg, unique_id):
    if pil_bg is None or folder_paths is None:
        return None
    try:
        img = pil_bg.convert("RGB")
        long_edge = max(img.size) or 1
        if long_edge > _BG_ECHO_LONG_EDGE:
            s = _BG_ECHO_LONG_EDGE / long_edge
            img = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)
        safe = re.sub(r"[^0-9A-Za-z_-]", "_", str(unique_id))
        name = f"bboxlegacy_bg_{safe}.jpg"
        img.save(os.path.join(folder_paths.get_temp_directory(), name), quality=88)
        return {
            "filename": name,
            "subfolder": "",
            "type": "temp",
            # 프론트에서 "이미지 크기에 맞추기" 에 사용할 원본 해상도
            "orig_width": pil_bg.width,
            "orig_height": pil_bg.height,
        }
    except Exception:
        return None


def _parse_json_list(value) -> list:
    if isinstance(value, list):
        return value
    if not isinstance(value, str) or not value.strip():
        return []
    try:
        parsed = json.loads(value)
    except (ValueError, TypeError):
        return []
    return parsed if isinstance(parsed, list) else []


# --------------------------------------------------------------------------- #
# node
# --------------------------------------------------------------------------- #
class CreateBoundingBoxesLegacy:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {
                    "default": 1024, "min": 64, "max": 16384, "step": 16,
                    "tooltip": "Width of the canvas and the pixel grid for the bounding boxes.",
                }),
                "height": ("INT", {
                    "default": 1024, "min": 64, "max": 16384, "step": 16,
                    "tooltip": "Height of the canvas and the pixel grid for the bounding boxes.",
                }),
                # 캔버스 UI 가 관리하는 내부 상태 (JS 에서 숨김)
                "editor_state": ("STRING", {"default": "[]", "socketless": True}),
            },
            "optional": {
                "background": ("IMAGE", {
                    "tooltip": "Optional image used as background in the canvas and preview.",
                }),
                "bboxes": ("BOUNDING_BOX,ARRAY,STRING", {
                    "tooltip": "Bounding boxes, elements, or a JSON string to initialize the canvas. "
                               "A new upstream value initializes the canvas; edits made on the canvas "
                               "take priority and are kept until the upstream value changes again.",
                }),
                "last_incoming": ("STRING", {"default": "[]", "socketless": True}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "BOUNDING_BOX", "ARRAY")
    RETURN_NAMES = ("preview", "bboxes", "elements")
    FUNCTION = "execute"
    CATEGORY = "utilities"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Draw bounding boxes in a canvas. Outputs Ideogram prompt elements, "
        "pixel-space bounding boxes, and a preview image. (node 1.0 port)"
    )

    def execute(self, width, height, editor_state="[]", background=None, bboxes=None,
                last_incoming="[]", unique_id=None):
        incoming = boxes_from_input(bboxes, width, height)
        applied = _parse_json_list(last_incoming)
        upstream_changed = bool(incoming) and incoming != applied

        source = incoming if upstream_changed else _parse_json_list(editor_state)
        regions = boxes_to_regions(source, width, height)

        pil_bg = _bg_from_image(background)
        preview = render_preview(regions, width, height, pil_bg)

        ui = {"dims": [width, height]}
        if incoming:
            ui["input_bboxes"] = incoming
        echoed = _echo_background(pil_bg, unique_id)
        if echoed:
            ui["bbox_bg"] = [echoed]

        return {
            "ui": ui,
            "result": (
                preview,
                fractions_to_bbox_frame(regions, width, height),
                build_elements(regions),
            ),
        }


NODE_CLASS_MAPPINGS = {"CreateBoundingBoxesLegacy": CreateBoundingBoxesLegacy}
NODE_DISPLAY_NAME_MAPPINGS = {"CreateBoundingBoxesLegacy": "Create Bounding Boxes for node 1.0"}
