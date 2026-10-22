package audio

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

func TestProcess(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	cases := []struct {
		name       string
		rate, bits int
		sampleFmt  string
		wantPCM    string
	}{
		{"cd", 44100, 16, "s16", "pcm_s16le"},
		{"hires", 96000, 24, "s32", "pcm_s24le"},
		{"ultra", 192000, 24, "s32", "pcm_s24le"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			dir := t.TempDir()
			src := filepath.Join(dir, "src.flac")
			// 45 s of music-like content: two tones plus pink noise.
			err := ffmpeg(ctx, "-f", "lavfi", "-i", "sine=frequency=440:duration=45:sample_rate="+strconv.Itoa(tc.rate),
				"-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.2:duration=45:sample_rate="+strconv.Itoa(tc.rate),
				"-filter_complex", "[0][1]amix=inputs=2,pan=stereo|c0=c0|c1=c0", "-sample_fmt", tc.sampleFmt,
				"-bits_per_raw_sample", strconv.Itoa(tc.bits), "-c:a", "flac", src)
			if err != nil {
				t.Fatal(err)
			}

			out := filepath.Join(dir, "out")
			res, err := Process(ctx, src, out, 10.5, 30, "128k")
			if err != nil {
				t.Fatal(err)
			}
			if res.PCMCodec != tc.wantPCM {
				t.Errorf("pcm codec = %s, want %s", res.PCMCodec, tc.wantPCM)
			}
			header := int64(44) // canonical WAV header; >16 bit uses WAVE_FORMAT_EXTENSIBLE
			if tc.bits > 16 {
				header = 68
			}
			wantSize := int64(30*tc.rate*2*tc.bits/8) + header
			if res.FileSize != wantSize {
				t.Errorf("file size = %d, want %d", res.FileSize, wantSize)
			}
			for _, f := range []string{LosslessFile, EncodedFile} {
				info, err := Probe(ctx, filepath.Join(out, f))
				if err != nil {
					t.Fatal(err)
				}
				if info.SampleRate != tc.rate || info.Channels != 2 || info.BitDepth != tc.bits {
					t.Errorf("%s: got %d Hz / %d ch / %d bit", f, info.SampleRate, info.Channels, info.BitDepth)
				}
			}
			if _, err := os.Stat(filepath.Join(out, "tmp.m4a")); !os.IsNotExist(err) {
				t.Error("temporary m4a was not removed")
			}
		})
	}
}

func TestRejectsLossySource(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	ctx := context.Background()
	dir := t.TempDir()
	src := filepath.Join(dir, "src.m4a")
	if err := ffmpeg(ctx, "-f", "lavfi", "-i", "sine=duration=40", "-c:a", "aac", src); err != nil {
		t.Fatal(err)
	}
	if _, err := Process(ctx, src, filepath.Join(dir, "out"), 0, 30, "128k"); err == nil {
		t.Fatal("expected lossy source to be rejected")
	}
}
