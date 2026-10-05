"""
直接调用本地 laya 进行 64x64 像素概率预测与生成
"""
import sys
import json

def run_laya(prompt="二次元古风少女", size=64):
    try:
        import laya
    except ImportError:
        print(json.dumps({"error": "未检测到 laya 包，请确认已 pip install laya"}))
        return

    try:
        # 加载本地/官方预训练权重
        agent = laya.load("convaiinnovations/laya")
    except Exception as e:
        print(json.dumps({"error": f"加载 laya 权重失败: {str(e)}"}))
        return

    state = {
        "image_description": prompt,
        "width": size,
        "height": size,
        "task": "pixel art grid coloring"
    }

    # 16 色调色板
    palette = ["black", "white", "gray", "red", "orange", "pink", "brown", "tan", "green", "dark_green", "blue", "sky_blue", "yellow", "purple", "navy", "cream"]
    criteria = {c: f"This pixel is {c}" for c in palette}

    # 批次预测
    questions = {}
    for y in range(min(16, size)):
        for x in range(min(16, size)):
            questions[f"p_{x}_{y}"] = {"type": "choice", "criteria": criteria}

    try:
        res = agent.predict(state, questions)
        print(json.dumps({"ok": True, "answers_count": len(res.answers)}))
    except Exception as e:
        print(json.dumps({"error": f"预测失败: {str(e)}"}))

if __name__ == "__main__":
    run_laya()
