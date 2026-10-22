// Package audio cuts a lossless source into the two WAV clips used by the quiz:
//
//	source -> cut -> WAV                               (lossless.wav)
//	source -> cut -> AAC 128 kbps -> decode -> WAV     (encoded.wav)
//
// Both WAVs share sample rate, channel layout, bit depth and exact sample
// count, and are written with bit-exact headers, so they are byte-for-byte
// the same size and indistinguishable by metadata.
package audio

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	LosslessFile = "lossless.wav"
	EncodedFile  = "encoded.wav"

	// The native ffmpeg AAC encoder accepts at most 96 kHz.
	maxAACSampleRate = 96000
)

// losslessCodecs are the source codecs we accept. Lossy input would make the
// "lossless" reference meaningless.
var losslessCodecs = map[string]bool{
	"flac": true, "alac": true, "wavpack": true, "ape": true, "tta": true, "mlp": true, "truehd": true,
}

type Info struct {
	Codec      string
	SampleRate int
	Channels   int
	BitDepth   int
	SampleFmt  string
	Duration   float64 // seconds
}

type Result struct {
	Info     Info
	PCMCodec string
	FileSize int64
}

// Probe reads the first audio stream of path.
func Probe(ctx context.Context, path string) (*Info, error) {
	out, err := run(ctx, "ffprobe", "-v", "error", "-select_streams", "a:0",
		"-show_entries", "stream=codec_name,sample_rate,channels,sample_fmt,bits_per_raw_sample,bits_per_sample,duration:format=duration",
		"-of", "json", path)
	if err != nil {
		return nil, err
	}
	var p struct {
		Streams []struct {
			CodecName        string `json:"codec_name"`
			SampleRate       string `json:"sample_rate"`
			Channels         int    `json:"channels"`
			SampleFmt        string `json:"sample_fmt"`
			BitsPerRawSample string `json:"bits_per_raw_sample"`
			BitsPerSample    int    `json:"bits_per_sample"`
			Duration         string `json:"duration"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &p); err != nil {
		return nil, fmt.Errorf("parse ffprobe output: %w", err)
	}
	if len(p.Streams) == 0 {
		return nil, fmt.Errorf("в файле нет аудиодорожки")
	}
	st := p.Streams[0]
	info := &Info{Codec: st.CodecName, Channels: st.Channels, SampleFmt: st.SampleFmt}
	info.SampleRate, _ = strconv.Atoi(st.SampleRate)
	info.BitDepth, _ = strconv.Atoi(st.BitsPerRawSample)
	if info.BitDepth == 0 {
		info.BitDepth = st.BitsPerSample
	}
	if info.BitDepth == 0 {
		info.BitDepth = bitsFromSampleFmt(st.SampleFmt)
	}
	dur := st.Duration
	if dur == "" || dur == "N/A" {
		dur = p.Format.Duration
	}
	info.Duration, _ = strconv.ParseFloat(dur, 64)
	if info.SampleRate == 0 || info.Channels == 0 || info.BitDepth == 0 {
		return nil, fmt.Errorf("не удалось определить параметры аудио (codec=%s rate=%d ch=%d bits=%d)",
			info.Codec, info.SampleRate, info.Channels, info.BitDepth)
	}
	return info, nil
}

// Process cuts clipSeconds starting at startSeconds out of src and writes
// LosslessFile and EncodedFile into outDir.
func Process(ctx context.Context, src, outDir string, startSeconds float64, clipSeconds int, aacBitrate string) (*Result, error) {
	info, err := Probe(ctx, src)
	if err != nil {
		return nil, err
	}
	if !losslessCodecs[info.Codec] && !strings.HasPrefix(info.Codec, "pcm_") {
		return nil, fmt.Errorf("исходник должен быть lossless (FLAC, WAV, ALAC, AIFF, WavPack…), а не %q", info.Codec)
	}
	if startSeconds < 0 {
		return nil, fmt.Errorf("начало отрывка не может быть отрицательным")
	}
	if info.Duration > 0 && startSeconds+float64(clipSeconds) > info.Duration+0.001 {
		return nil, fmt.Errorf("трек длится %.1f с — отрывок %d с с позиции %.1f с не помещается",
			info.Duration, clipSeconds, startSeconds)
	}
	pcm, err := pcmCodec(info)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, err
	}

	startSample := int64(math.Round(startSeconds * float64(info.SampleRate)))
	nSamples := int64(clipSeconds) * int64(info.SampleRate)
	rate := strconv.Itoa(info.SampleRate)
	channels := strconv.Itoa(info.Channels)
	// Strip all metadata and encoder tags so both files have identical headers.
	bitexact := []string{"-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"}

	// 1. Sample-accurate cut straight to PCM: this is the lossless reference.
	lossless := filepath.Join(outDir, LosslessFile)
	args := []string{"-i", src, "-map", "0:a:0", "-vn",
		"-af", fmt.Sprintf("atrim=start_sample=%d:end_sample=%d,asetpts=PTS-STARTPTS", startSample, startSample+nSamples),
		"-c:a", pcm, "-ar", rate, "-ac", channels}
	if err := ffmpeg(ctx, append(append(args, bitexact...), lossless)...); err != nil {
		return nil, fmt.Errorf("нарезка: %w", err)
	}

	// 2. Encode the very same cut to AAC. The MP4 container records the
	//    encoder delay in an edit list, so decoding stays sample-aligned.
	aac := filepath.Join(outDir, "tmp.m4a")
	defer os.Remove(aac)
	args = []string{"-i", lossless, "-c:a", "aac", "-b:a", aacBitrate}
	if info.SampleRate > maxAACSampleRate {
		args = append(args, "-ar", "48000")
	}
	if err := ffmpeg(ctx, append(args, aac)...); err != nil {
		return nil, fmt.Errorf("кодирование AAC: %w", err)
	}

	// 3. Decode back to WAV with exactly the same format and length.
	encoded := filepath.Join(outDir, EncodedFile)
	args = []string{"-i", aac,
		"-af", fmt.Sprintf("aresample=%s,apad=whole_len=%d,atrim=end_sample=%d", rate, nSamples, nSamples),
		"-c:a", pcm, "-ar", rate, "-ac", channels}
	if err := ffmpeg(ctx, append(append(args, bitexact...), encoded)...); err != nil {
		return nil, fmt.Errorf("декодирование AAC: %w", err)
	}

	// Sanity check: identical size means identical format and sample count.
	ls, err := os.Stat(lossless)
	if err != nil {
		return nil, err
	}
	es, err := os.Stat(encoded)
	if err != nil {
		return nil, err
	}
	if ls.Size() != es.Size() {
		return nil, fmt.Errorf("размеры WAV не совпадают: lossless=%d, encoded=%d", ls.Size(), es.Size())
	}
	return &Result{Info: *info, PCMCodec: pcm, FileSize: ls.Size()}, nil
}

// pcmCodec picks the WAV sample format that preserves the source bit depth.
func pcmCodec(info *Info) (string, error) {
	float := strings.HasPrefix(info.SampleFmt, "flt") || strings.HasPrefix(info.SampleFmt, "dbl")
	switch {
	case float && info.BitDepth == 64:
		return "pcm_f64le", nil
	case float:
		return "pcm_f32le", nil
	case info.BitDepth <= 16:
		return "pcm_s16le", nil
	case info.BitDepth <= 24:
		return "pcm_s24le", nil
	case info.BitDepth <= 32:
		return "pcm_s32le", nil
	}
	return "", fmt.Errorf("неподдерживаемая разрядность: %d бит", info.BitDepth)
}

func bitsFromSampleFmt(f string) int {
	switch strings.TrimSuffix(f, "p") {
	case "u8":
		return 8
	case "s16":
		return 16
	case "s32", "flt":
		return 32
	case "s64", "dbl":
		return 64
	}
	return 0
}

func ffmpeg(ctx context.Context, args ...string) error {
	_, err := run(ctx, "ffmpeg", append([]string{"-nostdin", "-hide_banner", "-v", "error", "-y"}, args...)...)
	return err
}

func run(ctx context.Context, name string, args ...string) ([]byte, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}
