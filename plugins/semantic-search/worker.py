import contextlib
from dataclasses import asdict
from functools import partial
import importlib.metadata
import importlib.util
import json
import os
import sys
import traceback


protocol_output = sys.stdout
model_instance = None
loaded_config = None


class RuntimeFailure(Exception):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


def emit(value):
    protocol_output.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    protocol_output.flush()


def status(message, **extra):
    emit({"status": "preparing", "message": message, **extra})


def dependencies(config):
    required = {"torch": "torch", "torchvision": "torchvision", "sentence-transformers": "sentence_transformers", "transformers": "transformers"}
    missing = [name for name, module in required.items() if importlib.util.find_spec(module) is None]
    if missing:
        raise RuntimeFailure("缺少语义模型依赖，请先安装专用环境：" + ", ".join(missing), "DEPENDENCIES_MISSING")
    try:
        import torch
        import torchvision
        import transformers
        from sentence_transformers import SentenceTransformer
        from transformers.models.auto.configuration_auto import CONFIG_MAPPING
    except Exception as error:
        raise RuntimeFailure("语义模型依赖不能正常导入：" + str(error), "DEPENDENCIES_INVALID") from error
    if "embedding_gemma2" not in CONFIG_MAPPING:
        raise RuntimeFailure("当前 transformers 不支持 EmbeddingGemma 2，请更新专用环境依赖", "MODEL_UNSUPPORTED")
    versions = {}
    for name in [*required, "Pillow", "av", "soundfile", "librosa"]:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    vision = bool(config.get("vision", True))
    audio = bool(config.get("audio", True))
    capabilities = {
        "text": True,
        "code": True,
        "images": vision and importlib.util.find_spec("PIL") is not None,
        "video": vision and importlib.util.find_spec("av") is not None and importlib.util.find_spec("torchvision") is not None,
        "audio": audio and importlib.util.find_spec("soundfile") is not None and importlib.util.find_spec("librosa") is not None,
    }
    return versions, capabilities


def cached_path(config):
    name = config["model"]
    if os.path.isdir(name):
        candidate = name
    else:
        from huggingface_hub import snapshot_download
        from huggingface_hub.errors import LocalEntryNotFoundError
        try:
            candidate = snapshot_download(name, cache_dir=config["cacheDir"], local_files_only=True)
        except LocalEntryNotFoundError:
            return None
    required_files = ["config.json", "tokenizer.json", "tokenizer_config.json", "processor_config.json", "preprocessor_config.json", "config_sentence_transformers.json", "modules.json", "chat_template.jinja"]
    if any(not os.path.isfile(os.path.join(candidate, name)) for name in required_files):
        return None
    files = os.listdir(candidate)
    if not any(name.endswith((".safetensors", ".bin")) for name in files):
        return None
    with open(os.path.join(candidate, "modules.json"), encoding="utf-8") as source:
        modules = json.load(source)
    if any(module.get("path") and not os.path.isfile(os.path.join(candidate, module["path"], "config.json")) for module in modules):
        return None
    return candidate


def select_device(config):
    import torch
    device = config.get("device", "cpu")
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeFailure("CUDA 不可用，请在「更多」一键配置对应依赖并检查 NVIDIA 驱动，或选择 CPU", "CUDA_UNAVAILABLE")
    return device


def probe(config):
    versions, capabilities = dependencies(config)
    candidate = cached_path(config)
    return {
        "model": config["model"],
        "dimensions": config["dimensions"],
        "device": select_device(config),
        "dependencies": versions,
        "capabilities": capabilities,
        "cached": candidate is not None,
        "cachePath": candidate,
        "loaded": model_instance is not None,
    }


def load_model(config, download=False):
    global model_instance, loaded_config
    if model_instance is not None:
        if config != loaded_config:
            raise RuntimeFailure("模型配置已变化，请重新启动模型运行时", "CONFIG_CHANGED")
        return model_instance
    versions, capabilities = dependencies(config)
    if not download and cached_path(config) is None:
        raise RuntimeFailure("模型权重尚未准备，请在设置中下载并准备模型", "MODEL_NOT_CACHED")
    import torch
    from sentence_transformers import SentenceTransformer
    device = select_device(config)
    precision = torch.bfloat16 if str(device).startswith("cuda") and torch.cuda.is_bf16_supported() else torch.float32
    config_kwargs = {}
    if not config.get("vision", True):
        config_kwargs["vision_config"] = None
    if not config.get("audio", True):
        config_kwargs["audio_config"] = None
    cached_dir = cached_path(config)
    local_only = (cached_dir is not None) or (not download)
    status("正在载入本地已缓存模型" if local_only else "正在下载模型权重", model=config["model"], device=device)
    model_instance = SentenceTransformer(
        config["model"],
        cache_folder=config["cacheDir"],
        device=device,
        config_kwargs=config_kwargs,
        model_kwargs={"torch_dtype": precision},
        local_files_only=local_only,
    )
    native_dimensions = model_instance.get_embedding_dimension()
    if native_dimensions != 768:
        model_instance = None
        raise RuntimeFailure("模型原始向量维度应为 768，实际为 " + str(native_dimensions), "INVALID_DIMENSIONS")
    loaded_config = dict(config)
    emit({"status": "ready", "message": "语义模型已载入", "model": config["model"], "device": device, "precision": str(precision).removeprefix("torch.")})
    return model_instance


def prepare(config):
    load_model(config, download=True)
    result = probe(config)
    result["precision"] = str(next(model_instance.parameters()).dtype).removeprefix("torch.")
    return result


def decode_video(path, model):
    from transformers.video_utils import load_video
    processor = model[0].processor.video_processor
    sample = partial(processor.sample_frames, fps=processor.fps, max_frames=processor.max_frames, overflow_strategy=processor.overflow_strategy)
    frames, metadata = load_video(path, backend="pyav", sample_indices_fn=sample)
    return {"array": frames, "video_metadata": asdict(metadata)}


def prepare_item(item, config, model):
    if not isinstance(item, dict):
        raise RuntimeFailure("模型输入必须为对象", "INVALID_INPUT")
    value = {}
    text = item.get("text")
    if text is not None:
        if not isinstance(text, str):
            raise RuntimeFailure("文字输入必须为字符串", "INVALID_INPUT")
        value["text"] = text
    for modality in ["image", "audio", "video"]:
        media = item.get(modality)
        if media is None:
            continue
        if modality in ["image", "video"] and not config.get("vision", True):
            raise RuntimeFailure("图片与视频编码器尚未启用", "MODALITY_DISABLED")
        if modality == "audio" and not config.get("audio", True):
            raise RuntimeFailure("音频编码器尚未启用", "MODALITY_DISABLED")
        paths = media if isinstance(media, list) else [media]
        if not paths or any(not isinstance(path, str) or not os.path.isfile(path) for path in paths):
            raise RuntimeFailure(modality + " 输入需要存在的本地文件", "INVALID_MEDIA")
        if modality == "image":
            from PIL import Image, ImageOps
            decoded = []
            for path in paths:
                try:
                    with Image.open(path) as image:
                        image.seek(0)
                        decoded.append(ImageOps.exif_transpose(image).convert("RGB").copy())
                except Exception as error:
                    raise RuntimeFailure("图片读取失败 " + path + ": " + str(error), "INVALID_MEDIA") from error
            value[modality] = decoded if isinstance(media, list) else decoded[0]
        elif modality == "video":
            decoded = [decode_video(path, model) for path in paths]
            value[modality] = decoded if isinstance(media, list) else decoded[0]
        else:
            value[modality] = media
        if text is not None:
            token = "<|" + modality + "|>"
            occurrences = value["text"].count(token)
            if occurrences == 0:
                value["text"] += " " + " ".join([token] * len(paths))
            elif occurrences != len(paths):
                raise RuntimeFailure(modality + " 占位符数量与文件数量不一致", "INVALID_INPUT")
    if not value:
        raise RuntimeFailure("输入缺少文字或媒体", "INVALID_INPUT")
    if set(value) == {"text"}:
        # 转义可能干扰多模态 tokenizer 的特殊 token，防止误当作图像/音频输入
        return value["text"].replace("<|image|>", "<| escaped_image |>").replace("<|video|>", "<| escaped_video |>").replace("<|audio|>", "<| escaped_audio |>")
    return value


def encode(request):
    import numpy as np
    config = request["config"]
    dimensions = config["dimensions"]
    if dimensions not in [128, 256, 512, 768]:
        raise RuntimeFailure("向量维度不受支持", "INVALID_DIMENSIONS")
    items = request.get("items")
    if not isinstance(items, list):
        raise RuntimeFailure("输入需要为数组", "INVALID_INPUT")
    if not items:
        return []
    model = load_model(config)
    inputs = [prepare_item(item, config, model) for item in items]
    results = [None] * len(inputs)
    groups = {}
    for index, item in enumerate(inputs):
        has_text = isinstance(item, str) or bool(item.get("text"))
        prompt = ("CodeRetrieval" if request.get("code") else "SearchQuery") if request.get("query") and has_text else None
        groups.setdefault(prompt, []).append((index, item))
    for prompt, group in groups.items():
        kwargs = {"prompt_name": prompt} if prompt else {"prompt": ""}
        if any(item.get("video") is not None for item in items):
            kwargs["processing_kwargs"] = {"video": {"do_sample_frames": False}}
        vectors = model.encode(
            [item for _, item in group],
            batch_size=8,
            show_progress_bar=False,
            convert_to_numpy=True,
            normalize_embeddings=True,
            truncate_dim=dimensions,
            **kwargs,
        )
        vectors = np.asarray(vectors, dtype=np.float32)
        if vectors.shape != (len(group), dimensions) or not np.isfinite(vectors).all():
            raise RuntimeFailure("模型返回非有限数值或错误向量维度", "INVALID_VECTOR")
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if (norms == 0).any():
            raise RuntimeFailure("模型返回空向量", "INVALID_VECTOR")
        vectors = vectors / norms
        for (index, _), vector in zip(group, vectors):
            results[index] = vector.tolist()
    return results


def handle(request):
    if not isinstance(request, dict) or not isinstance(request.get("config"), dict):
        raise RuntimeFailure("请求格式无效", "INVALID_REQUEST")
    operation = request.get("op")
    if operation == "probe":
        return probe(request["config"])
    if operation == "prepare":
        return prepare(request["config"])
    if operation == "encode":
        return encode(request)
    raise RuntimeFailure("未知模型操作：" + str(operation), "INVALID_REQUEST")


for line in sys.stdin:
    request_id = None
    try:
        request = json.loads(line)
        request_id = request.get("id") if isinstance(request, dict) else None
        with contextlib.redirect_stdout(sys.stderr):
            result = handle(request)
        emit({"id": request_id, "ok": True, "result": result})
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit({"id": request_id, "ok": False, "error": str(error), "code": getattr(error, "code", "MODEL_ERROR")})
