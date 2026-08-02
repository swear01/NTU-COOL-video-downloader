#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
name="NTU-COOL-video-downloader-$version"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "release" "$stage/$name"
cp manifest.json LICENSE README.md README.zh-TW.md "$stage/$name/"
cp -R background icons offscreen popup utils vendor "$stage/$name/"
rm -f "release/$name.zip"
(cd "$stage" && zip -X -q -r "$OLDPWD/release/$name.zip" "$name")
printf '%s\n' "release/$name.zip"
