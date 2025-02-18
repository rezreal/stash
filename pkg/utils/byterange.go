package utils

import (
	"strconv"
	"strings"
)

type ByteRange struct {
	Start     int64
	End       *int64
	RawString string
}

func CreateByteRange(s string) ByteRange {
	// strip bytes=
	r := strings.TrimPrefix(s, "bytes=")
	e := strings.Split(r, "-")

	ret := ByteRange{
		RawString: s,
	}
	if len(e) > 0 {
		ret.Start, _ = strconv.ParseInt(e[0], 10, 64)
	}
	if len(e) > 1 && e[1] != "" {
		end, _ := strconv.ParseInt(e[1], 10, 64)
		ret.End = &end
	}

	return ret
}

func (r ByteRange) ToHeaderValue(fileLength int64) string {
	if r.End == nil {
		return ""
	}
	end := *r.End
	return "bytes " + strconv.FormatInt(r.Start, 10) + "-" + strconv.FormatInt(end, 10) + "/" + strconv.FormatInt(fileLength, 10)
}

func (r ByteRange) Apply(bytes []byte) []byte {
	if r.End == nil {
		return bytes[r.Start:]
	}

	end := *r.End + 1
	if int(end) > len(bytes) {
		end = int64(len(bytes))
	}
	return bytes[r.Start:end]
}
