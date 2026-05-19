#!/usr/bin/env bash
set -euo pipefail

# 确立目录
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
CRATE_DIR="$DIR"
OUT_DIR="$CRATE_DIR/out"

echo "🧹 Cleaning previous build..."
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "🦀 Building Rust library for macOS..."
# 注意：我们这里为了快速演示，只构建了针对当前 Mac 的架构 (比如 aarch64-apple-darwin)。
# 如果你想发布给别人，需要用 lipo 把 x86_64 和 aarch64 打包成 universal binary。
cd "$CRATE_DIR"
cargo build --release

# 获取编译出的动态库路径
LIB_PATH="$CRATE_DIR/../../target/release/libquilin_bridge.dylib"

echo "📜 Generating Swift bindings..."
# 运行我们在 src/bin/uniffi-bindgen.rs 定义的生成器
cargo run --bin uniffi-bindgen generate --library "$LIB_PATH" --language swift --out-dir "$OUT_DIR"

# 整理产物
# UniFFI 会生成 quilin_bridgeFFI.modulemap, quilin_bridge.swift 等文件
# 真正的工程实践中，我们会在这里调用 xcodebuild -create-xcframework 
# 但作为第一步原型，我们先把 .dylib 和 .swift 文件提取出来供 Xcode 直接链接。

cp "$LIB_PATH" "$OUT_DIR/"

# Xcode requires the file to be exactly named "module.modulemap" to find it via Import Paths
mv "$OUT_DIR/quilin_bridgeFFI.modulemap" "$OUT_DIR/module.modulemap"

echo "✅ Build complete! Artifacts are in $OUT_DIR"
echo "You can now copy the .swift file and .dylib into your Xcode project."
