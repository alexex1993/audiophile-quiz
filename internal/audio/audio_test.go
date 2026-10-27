package audio

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

var testBitrates = []string{"32k", "128k", "320k"}

func TestProcess(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	cases := []struct {
		name       string
		rate, bits int
		sampleFmt  string
	}{
		{"cd", 44100, 16, "s16"},
		{"hires", 96000, 24, "s32"},
		{"ultra", 192000, 24, "s32"},
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
			res, err := Process(ctx, src, out, 10.5, 30, testBitrates)
			if err != nil {
				t.Fatal(err)
			}
			files := []string{LosslessFile}
			for _, b := range testBitrates {
				files = append(files, EncodedFile(b))
			}
			for _, f := range files {
				path := filepath.Join(out, f)
				st, err := os.Stat(path)
				if err != nil {
					t.Fatal(err)
				}
				if st.Size() != res.FileSize {
					t.Errorf("%s: size = %d, want %d", f, st.Size(), res.FileSize)
				}
				info, err := Probe(ctx, path)
				if err != nil {
					t.Fatal(err)
				}
				if info.Codec != "flac" || info.SampleRate != tc.rate || info.Channels != 2 || info.BitDepth != tc.bits {
					t.Errorf("%s: got %s %d Hz / %d ch / %d bit", f, info.Codec, info.SampleRate, info.Channels, info.BitDepth)
				}
				if info.Duration != 30 {
					t.Errorf("%s: duration = %v, want exactly 30 s", f, info.Duration)
				}
				// The rewritten metadata must still decode cleanly.
				if err := ffmpeg(ctx, "-xerror", "-i", path, "-f", "null", "-"); err != nil {
					t.Errorf("%s: decode: %v", f, err)
				}
			}
			if tmp, _ := filepath.Glob(filepath.Join(out, "*.m4a")); len(tmp) > 0 {
				t.Errorf("temporary m4a not removed: %v", tmp)
			}
		})
	}
}

func TestLosslessClipIsBitExact(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	ctx := context.Background()
	dir := t.TempDir()
	src := filepath.Join(dir, "src.flac")
	if err := ffmpeg(ctx, "-f", "lavfi", "-i", "anoisesrc=color=pink:duration=45:sample_rate=48000",
		"-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-c:a", "flac", src); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "out")
	if _, err := Process(ctx, src, out, 10, 30, testBitrates); err != nil {
		t.Fatal(err)
	}
	md5 := func(args ...string) string {
		b, err := run(ctx, "ffmpeg", append(append([]string{"-v", "error"}, args...), "-c:a", "pcm_s32le", "-f", "md5", "-")...)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	want := md5("-i", src, "-af", "atrim=start_sample=480000:end_sample=1920000")
	if got := md5("-i", filepath.Join(out, LosslessFile)); got != want {
		t.Errorf("lossless clip samples differ from the source: %s vs %s", got, want)
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
	if _, err := Process(ctx, src, filepath.Join(dir, "out"), 0, 30, testBitrates); err == nil {
		t.Fatal("expected lossy source to be rejected")
	}
}

func TestReencode(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	ctx := context.Background()
	dir := t.TempDir()
	src := filepath.Join(dir, "src.flac")
	if err := ffmpeg(ctx, "-f", "lavfi", "-i", "anoisesrc=color=pink:duration=45:sample_rate=96000",
		"-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-c:a", "flac", src); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, "old")
	if _, err := Process(ctx, src, old, 10, 30, []string{"64k", "128k", "320k"}); err != nil {
		t.Fatal(err)
	}
	synced := filepath.Join(dir, "synced")
	size, err := Reencode(ctx, old, synced, testBitrates)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(synced, EncodedFile("64k"))); !os.IsNotExist(err) {
		t.Error("stale 64k clip was copied")
	}
	if _, err := os.Stat(filepath.Join(old, EncodedFile("64k"))); err != nil {
		t.Errorf("source directory was changed: %v", err)
	}

	// The result must be exactly what a fresh upload at the new bitrates gives.
	fresh := filepath.Join(dir, "fresh")
	res, err := Process(ctx, src, fresh, 10, 30, testBitrates)
	if err != nil {
		t.Fatal(err)
	}
	if size != res.FileSize {
		t.Errorf("size = %d, want %d", size, res.FileSize)
	}
	files := []string{LosslessFile}
	for _, b := range testBitrates {
		files = append(files, EncodedFile(b))
	}
	for _, f := range files {
		got, err := os.ReadFile(filepath.Join(synced, f))
		if err != nil {
			t.Fatal(err)
		}
		want, err := os.ReadFile(filepath.Join(fresh, f))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s differs from a fresh Process", f)
		}
	}
}
