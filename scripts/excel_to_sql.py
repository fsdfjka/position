"""
用真实 Excel 生成 MySQL seed SQL
用法：python scripts/excel_to_sql.py
"""
import pandas as pd
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXCEL = r'c:\Users\34055\Desktop\道路监控点位清单.xlsx'
OUT_SQL = ROOT / 'database/seed-from-excel.sql'

# 路口坐标 + 道路名（稳定地理数据，来自首次 Excel 导入时的经纬度底表）
INTERSECTION_META = {
    '泉秀刺桐': {'lng': 118.6008400, 'lat': 24.8901400, 'roads': '泉秀街 × 刺桐路'},
    '刺桐津淮': {'lng': 118.6034200, 'lat': 24.8969100, 'roads': '刺桐路 × 津淮街'},
    '刺桐丰泽': {'lng': 118.6063600, 'lat': 24.9046900, 'roads': '刺桐路 × 丰泽街'},
    '刺桐湖心': {'lng': 118.6078700, 'lat': 24.9087000, 'roads': '刺桐路 × 湖心街'},
    '刺桐东湖': {'lng': 118.6097200, 'lat': 24.9134100, 'roads': '刺桐路 × 东湖街'},
    '田安东湖': {'lng': 118.6047600, 'lat': 24.9141400, 'roads': '田安路 × 东湖街'},
    '田安湖心': {'lng': 118.6033000, 'lat': 24.9089700, 'roads': '田安路 × 湖心街'},
    '田安丰泽': {'lng': 118.6013800, 'lat': 24.9056200, 'roads': '田安路 × 丰泽街'},
    '田安津淮': {'lng': 118.5975600, 'lat': 24.8989500, 'roads': '田安路 × 津淮街'},
    '田安泉秀': {'lng': 118.5945500, 'lat': 24.8938100, 'roads': '田安路 × 泉秀街'},
    '温陵泉秀': {'lng': 118.5898700, 'lat': 24.8979000, 'roads': '温陵路 × 泉秀街'},
    '温陵津淮': {'lng': 118.5921100, 'lat': 24.9022100, 'roads': '温陵路 × 津淮街'},
    '温陵丰泽': {'lng': 118.5946600, 'lat': 24.9071300, 'roads': '温陵路 × 丰泽街'},
    '东街南俊': {'lng': 118.5909400, 'lat': 24.9144400, 'roads': '东街 × 南俊路'},
    '打锡南俊': {'lng': 118.5879300, 'lat': 24.9090500, 'roads': '打锡街 × 南俊路'},
    '涂门百源': {'lng': 118.5885200, 'lat': 24.9041600, 'roads': '涂门街 × 百源路'},
    '中山打锡': {'lng': 118.5849200, 'lat': 24.9097400, 'roads': '中山路 × 打锡街'},
    '钟楼岗':   {'lng': 118.5865500, 'lat': 24.9152200, 'roads': '东街 × 中山路'},
    '新门新华': {'lng': 118.5783900, 'lat': 24.9122700, 'roads': '新门街 × 新华路'},
}

# 1. 读 Excel，跳过表头行
df = pd.read_excel(EXCEL, skiprows=1, header=0, names=['序号', '点位名称', '所属点位', '场景说明', '朝向'])
df = df.dropna(subset=['所属点位', '场景说明'])
df['序号'] = pd.to_numeric(df['序号'], errors='coerce')
print(f'Excel 相机总行数: {len(df)}')

# 3. 朝向归一化 → bearing + 八向文字
# 东北向/东北方向/东北/北边/北/南面 → 统一
BEARING_MAP = {
    '北': 0, '北边': 0, '北向': 0, '北方': 0,
    '东北': 45, '东北向': 45, '东北方向': 45,
    '东': 90, '东边': 90, '东向': 90, '东方': 90,
    '东南': 135, '东南向': 135, '东南方向': 135, '南边': 135, '南面': 135,  # 南边可能是东南，先看原文再修正
    '南': 180, '南边': 180, '南向': 180, '南方': 180, '南面': 180,
    '西南': 225, '西南向': 225, '西南方向': 225, '西边': 225, '西面': 225,
    '西': 270, '西边': 270, '西向': 270, '西方': 270,
    '西北': 315, '西北向': 315, '西北方向': 315,
}

def parse_bearing(text):
    if not text: return 90
    t = str(text).strip().replace(' ', '')
    # 先检查完整 key
    for k in sorted(BEARING_MAP.keys(), key=len, reverse=True):
        if k in t:
            return BEARING_MAP[k]
    return 90  # 兜底东向

BEARING_TO_DIR = {0:'北向', 45:'东北向', 90:'东向', 135:'东南向', 180:'南向', 225:'西南向', 270:'西向', 315:'西北向'}
def bearing_to_dir(b):
    return BEARING_TO_DIR.get(b % 360, '东向')

# 4. 路口分组
from collections import OrderedDict
intersections = OrderedDict()

for _, row in df.iterrows():
    code = str(row['所属点位']).strip()
    name = str(row['点位名称']).strip() if pd.notna(row['点位名称']) else code
    scene = str(row['场景说明']).strip()
    dir_raw = str(row['朝向']).strip() if pd.notna(row['朝向']) else ''
    bearing = parse_bearing(dir_raw)
    direction = bearing_to_dir(bearing)

    # 相机类型：含"联动快球"/"球机" → ptz，否则 traffic
    scene_type = 'ptz' if ('联动快球' in scene or '球机' in scene) else 'traffic'

    if code not in intersections:
        meta = INTERSECTION_META.get(code, {})
        intersections[code] = {
            'code': code,
            'name': name,
            'roads': meta.get('roads', ''),
            'lng': meta.get('lng'),
            'lat': meta.get('lat'),
            'origin': 0,  # 真实数据都是内置
            'cameras': [],
        }
    intersections[code]['cameras'].append({
        'scene': scene,
        'type': scene_type,
        'bearing': bearing,
        'dir_label': direction,
    })

print(f'分组后路口数: {len(intersections)}')
total_cams = sum(len(v['cameras']) for v in intersections.values())
print(f'总相机数: {total_cams}')

# 检查缺口
missing_coord = [k for k, v in intersections.items() if v['lng'] is None]
if missing_coord:
    print(f'⚠ 以下 {len(missing_coord)} 个路口在旧 JSON 中找不到坐标：', missing_coord)
    sys.exit(1)

# 5. 生成 SQL
def esc(s):
    if s is None: return 'NULL'
    return "'" + str(s).replace('\\', '\\\\').replace("'", "''") + "'"

intersection_rows = []
camera_rows = []
cam_id = 1

for i, (code, it) in enumerate(intersections.items(), start=1):
    intersection_rows.append(
        f"({i}, {esc(code)}, {esc(it['name'])}, {esc(it['roads'])}, {it['lng']:.7f}, {it['lat']:.7f}, {it['origin']})"
    )
    for c in it['cameras']:
        camera_rows.append(
            f"({cam_id}, {i}, {esc(c['scene'])}, {esc(c['type'])}, {c['bearing']}, {esc(c['dir_label'])})"
        )
        cam_id += 1

sql = f"""-- 由 Excel「道路监控点位清单.xlsx」生成
-- 路口 {len(intersection_rows)} 条 / 相机 {len(camera_rows)} 台
USE quanzhou_monitor;

SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE cameras;
TRUNCATE TABLE intersections;
SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO intersections (id, code, name, roads, lng, lat, origin) VALUES
{',\n'.join(intersection_rows)};

INSERT INTO cameras (id, intersection_id, scene, type, bearing, dir_label) VALUES
{',\n'.join(camera_rows)};
"""

OUT_SQL.write_text(sql, encoding='utf-8')
print(f'\n✅ 写入 {OUT_SQL}')
