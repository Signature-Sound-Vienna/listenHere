for f in *.wav; do out=${f%".wav"}; ffmpeg -i "$f" -codec:a libmp3lame -qscale:a 2 "$out.mp3"; done
