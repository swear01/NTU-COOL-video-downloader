#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
name="NTU-COOL-video-downloader-$version"
output="$PWD/release/$name.zip"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "release" "$stage/package"
cp manifest.json LICENSE PRIVACY.md README.md README.zh-TW.md "$stage/package/"
cp -R background icons offscreen popup utils vendor "$stage/package/"
rm -f "$output"
(cd "$stage/package" && zip -X -q -r "$output" .)
printf '%s\n' "release/$name.zip"
