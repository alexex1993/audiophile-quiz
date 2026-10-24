// Package audio cuts a lossless source into the FLAC clips used by the quiz:
//
//	source -> cut -> FLAC                              (lossless.flac)
//	source -> cut -> FLAC -> AAC <bitrate> -> FLAC     (encoded_<bitrate>.flac, one per bitrate)
//
// All FLACs share sample rate, channel layout, bit depth and exact sample
// count, and are written with bit-exact headers. FLAC compresses them
// differently, so the smaller ones get larger PADDING blocks to make every
// file exactly the same size; a download reveals nothing about the version.
package audio

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

const (
	LosslessFile = "lossless.flac"

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
	FileSize int64 // identical for all clips
}

// EncodedFile is the name of the clip that went through AAC at bitrate, e.g. "128k".
func EncodedFile(bitrate string) string { return "encoded_" + bitrate + ".flac" }

// UserError is a problem with the uploaded file itself, worded for the admin
// in both UI languages. Other errors are internal and English-only.
type UserError struct{ RU, EN string }

func (e *UserError) Error() string { return e.EN }

func userErrorf(ru, en string, args ...any) error {
	return &UserError{RU: fmt.Sprintf(ru, args...), EN: fmt.Sprintf(en, args...)}
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
		return nil, userErrorf("в файле нет аудиодорожки", "the file has no audio stream")
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
		return nil, userErrorf("не удалось определить параметры аудио (codec=%s rate=%d ch=%d bits=%d)",
			"could not determine audio parameters (codec=%s rate=%d ch=%d bits=%d)", info.Codec, info.SampleRate, info.Channels, info.BitDepth)
	}
	return info, nil
}

// Process cuts clipSeconds starting at startSeconds out of src and writes
// LosslessFile and an EncodedFile for each of bitrates into outDir.
func Process(ctx context.Context, src, outDir string, startSeconds float64, clipSeconds int, bitrates []string) (*Result, error) {
	info, err := Probe(ctx, src)
	if err != nil {
		return nil, err
	}
	if !losslessCodecs[info.Codec] && !strings.HasPrefix(info.Codec, "pcm_") {
		return nil, userErrorf("исходник должен быть lossless (FLAC, WAV, ALAC, AIFF, WavPack…), а не %q",
			"the source must be lossless (FLAC, WAV, ALAC, AIFF, WavPack…), not %q", info.Codec)
	}
	if startSeconds < 0 {
		return nil, userErrorf("начало отрывка не может быть отрицательным", "the clip start cannot be negative")
	}
	if info.Duration > 0 && startSeconds+float64(clipSeconds) > info.Duration+0.001 {
		return nil, userErrorf("трек длится %.1f с — отрывок %d с с позиции %.1f с не помещается",
			"the track is %.1f s long — a %d s clip starting at %.1f s does not fit", info.Duration, clipSeconds, startSeconds)
	}
	sampleFmt, err := flacSampleFmt(info)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, err
	}

	startSample := int64(math.Round(startSeconds * float64(info.SampleRate)))
	nSamples := int64(clipSeconds) * int64(info.SampleRate)
	output := flacOutput(info, sampleFmt)

	// 1. Sample-accurate cut, re-encoded to FLAC (losslessly: the samples are
	//    the source's own). This is the lossless reference.
	lossless := filepath.Join(outDir, LosslessFile)
	args := []string{"-i", src, "-map", "0:a:0", "-vn",
		"-af", fmt.Sprintf("atrim=start_sample=%d:end_sample=%d,asetpts=PTS-STARTPTS", startSample, startSample+nSamples)}
	if err := ffmpeg(ctx, append(append(args, output...), lossless)...); err != nil {
		return nil, fmt.Errorf("cut: %w", err)
	}

	clips := []string{lossless}
	for _, bitrate := range bitrates {
		encoded, err := encodeAAC(ctx, outDir, info, nSamples, output, bitrate)
		if err != nil {
			return nil, err
		}
		clips = append(clips, encoded)
	}

	size, err := equalizeFLACSizes(clips...)
	if err != nil {
		return nil, err
	}
	return &Result{Info: *info, FileSize: size}, nil
}

// Reencode brings a clip directory made by Process in line with bitrates:
// missing EncodedFiles are made from its LosslessFile exactly as Process
// would, ones for other bitrates are removed, and all clips are padded to
// equal size again. It returns that size.
func Reencode(ctx context.Context, dir string, bitrates []string) (int64, error) {
	lossless := filepath.Join(dir, LosslessFile)
	info, err := Probe(ctx, lossless)
	if err != nil {
		return 0, err
	}
	sampleFmt, err := flacSampleFmt(info)
	if err != nil {
		return 0, err
	}
	f, err := readFLAC(lossless)
	if err != nil {
		return 0, err
	}
	nSamples := f.totalSamples()
	if nSamples == 0 {
		return 0, fmt.Errorf("%s: STREAMINFO has no sample count", lossless)
	}
	output := flacOutput(info, sampleFmt)

	clips := []string{lossless}
	for _, bitrate := range bitrates {
		encoded := filepath.Join(dir, EncodedFile(bitrate))
		if _, err := os.Stat(encoded); errors.Is(err, os.ErrNotExist) {
			if encoded, err = encodeAAC(ctx, dir, info, nSamples, output, bitrate); err != nil {
				return 0, err
			}
		} else if err != nil {
			return 0, err
		}
		clips = append(clips, encoded)
	}
	stale, err := filepath.Glob(filepath.Join(dir, EncodedFile("*")))
	if err != nil {
		return 0, err
	}
	for _, p := range stale {
		if !slices.Contains(clips, p) {
			if err := os.Remove(p); err != nil {
				return 0, err
			}
		}
	}
	return equalizeFLACSizes(clips...)
}

// flacOutput is the ffmpeg output options of every clip: same encoder
// settings, metadata and encoder tags stripped, so all have identical headers.
func flacOutput(info *Info, sampleFmt string) []string {
	output := []string{"-c:a", "flac", "-compression_level", "8", "-sample_fmt", sampleFmt,
		"-ar", strconv.Itoa(info.SampleRate), "-ac", strconv.Itoa(info.Channels),
		"-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"}
	if sampleFmt == "s32" {
		output = append(output, "-bits_per_raw_sample", "24")
	}
	return output
}

// encodeAAC makes EncodedFile(bitrate) in outDir from its LosslessFile and
// returns its path.
func encodeAAC(ctx context.Context, outDir string, info *Info, nSamples int64, output []string, bitrate string) (string, error) {
	// 2. Encode the very same cut to AAC. The MP4 container records the
	//    encoder delay in an edit list, so decoding stays sample-aligned.
	aac := filepath.Join(outDir, "tmp.m4a")
	defer os.Remove(aac)
	args := []string{"-i", filepath.Join(outDir, LosslessFile), "-c:a", "aac", "-b:a", bitrate}
	if info.SampleRate > maxAACSampleRate {
		args = append(args, "-ar", "48000")
	}
	if err := ffmpeg(ctx, append(args, aac)...); err != nil {
		return "", fmt.Errorf("AAC %s encode: %w", bitrate, err)
	}

	// 3. Decode back to FLAC with exactly the same format and length.
	encoded := filepath.Join(outDir, EncodedFile(bitrate))
	args = []string{"-i", aac,
		"-af", fmt.Sprintf("aresample=%d,apad=whole_len=%d,atrim=end_sample=%d", info.SampleRate, nSamples, nSamples)}
	if err := ffmpeg(ctx, append(append(args, output...), encoded)...); err != nil {
		return "", fmt.Errorf("AAC %s decode: %w", bitrate, err)
	}
	return encoded, nil
}

// flacSampleFmt picks the FLAC encoder sample format that preserves the
// source bit depth. FLAC has no float samples, and browsers do not reliably
// play 32-bit FLAC.
func flacSampleFmt(info *Info) (string, error) {
	switch {
	case strings.HasPrefix(info.SampleFmt, "flt") || strings.HasPrefix(info.SampleFmt, "dbl"):
		return "", userErrorf("float-исходники не поддерживаются: FLAC хранит только целые сэмплы",
			"floating-point sources are not supported: FLAC stores integer samples only")
	case info.BitDepth <= 16:
		return "s16", nil
	case info.BitDepth <= 24:
		return "s32", nil
	}
	return "", userErrorf("неподдерживаемая разрядность: %d бит (максимум 24)", "unsupported bit depth: %d bits (24 at most)", info.BitDepth)
}

const (
	flacPadding      = 1 // metadata block type
	flacMaxBlockLen  = 1<<24 - 1
	flacBasePadding  = 8192 // padding every file gets, as ffmpeg writes by default
	flacBlockHdrSize = 4
)

// equalizeFLACSizes rewrites the PADDING of all files so that they end up
// exactly the same size, and returns that size. Every file gets padding, the
// smaller ones more of it.
func equalizeFLACSizes(paths ...string) (int64, error) {
	files := make([]*flacFile, len(paths))
	largest := 0
	for i, p := range paths {
		f, err := readFLAC(p)
		if err != nil {
			return 0, err
		}
		files[i] = f
		largest = max(largest, f.size())
	}
	target := largest + flacBlockHdrSize + flacBasePadding
	for _, f := range files {
		if err := f.writePadded(target); err != nil {
			return 0, err
		}
	}
	return int64(target), nil
}

type flacFile struct {
	path   string
	blocks [][]byte // non-padding metadata blocks, header included; STREAMINFO first
	frames []byte   // everything after the metadata
}

func readFLAC(path string) (*flacFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(data, []byte("fLaC")) {
		return nil, fmt.Errorf("%s: not a FLAC file", path)
	}
	f := &flacFile{path: path}
	pos := 4
	for last := false; !last; {
		if pos+flacBlockHdrSize > len(data) {
			return nil, fmt.Errorf("%s: truncated metadata", path)
		}
		hdr := binary.BigEndian.Uint32(data[pos:])
		last = hdr>>31 == 1
		typ := hdr >> 24 & 0x7f
		end := pos + flacBlockHdrSize + int(hdr&flacMaxBlockLen)
		if end > len(data) {
			return nil, fmt.Errorf("%s: truncated metadata block", path)
		}
		if typ != flacPadding {
			f.blocks = append(f.blocks, data[pos:end])
		}
		pos = end
	}
	if len(f.blocks) == 0 {
		return nil, fmt.Errorf("%s: no STREAMINFO", path)
	}
	f.frames = data[pos:]
	return f, nil
}

// totalSamples reads the per-channel sample count from STREAMINFO (36 bits
// at byte 13 of its body); 0 means unknown.
func (f *flacFile) totalSamples() int64 {
	si := f.blocks[0][flacBlockHdrSize:]
	if len(si) < 18 {
		return 0
	}
	return int64(si[13]&0x0f)<<32 | int64(binary.BigEndian.Uint32(si[14:]))
}

// size is the file size without any padding.
func (f *flacFile) size() int {
	n := 4 + len(f.frames)
	for _, b := range f.blocks {
		n += len(b)
	}
	return n
}

// writePadded rewrites the file to exactly target bytes, filling the gap with
// PADDING blocks (more than one only if the gap exceeds the 16 MiB block limit).
func (f *flacFile) writePadded(target int) error {
	gap := target - f.size()
	if gap < flacBlockHdrSize {
		return errors.New("FLAC padding gap too small")
	}
	var buf bytes.Buffer
	buf.Grow(target)
	buf.WriteString("fLaC")
	for _, b := range f.blocks {
		buf.WriteByte(b[0] & 0x7f) // clear the last-block flag
		buf.Write(b[1:])
	}
	for gap > 0 {
		n := min(gap-flacBlockHdrSize, flacMaxBlockLen)
		// Never leave a remainder too small for another block header.
		if rest := gap - flacBlockHdrSize - n; rest > 0 && rest < flacBlockHdrSize {
			n -= flacBlockHdrSize
		}
		gap -= flacBlockHdrSize + n
		hdr := uint32(flacPadding)<<24 | uint32(n)
		if gap == 0 {
			hdr |= 1 << 31
		}
		buf.Write(binary.BigEndian.AppendUint32(nil, hdr))
		buf.Write(make([]byte, n))
	}
	buf.Write(f.frames)
	if buf.Len() != target {
		return fmt.Errorf("%s: padded size %d, want %d", f.path, buf.Len(), target)
	}
	return os.WriteFile(f.path, buf.Bytes(), 0o644)
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
