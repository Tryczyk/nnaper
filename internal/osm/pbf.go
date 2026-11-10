package osm

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// NodeData reprezentuje węzeł OSM z współrzędnymi i tagami.
type NodeData struct {
	ID   int64
	Lat  float64
	Lon  float64
	Tags map[string]string
}

// WayData reprezentuje drogę/linię/obrys OSM z listą referencji węzłów i tagami.
type WayData struct {
	ID      int64
	NodeIDs []int64
	Tags    map[string]string
}

// RelationMember reprezentuje członka relacji OSM.
type RelationMember struct {
	ID   int64
	Type int // 0 = Node, 1 = Way, 2 = Relation
	Role string
}

// RelationData reprezentuje relację OSM (np. enforcement=average_speed, enforcement=maxspeed).
type RelationData struct {
	ID      int64
	Members []RelationMember
	Tags    map[string]string
}

// Callbacks definiuje funkcje wywoływane podczas strumieniowego czytania pliku .osm.pbf.
type Callbacks struct {
	OnNode     func(n NodeData)
	OnWay      func(w WayData)
	OnRelation func(r RelationData)
}

// ReadPBF odczytuje plik .osm.pbf bez zewnętrznych zależności (czysty Go stdlib).
func ReadPBF(filePath string, cb Callbacks) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()
	return ReadPBFFromReader(f, cb)
}

// ReadPBFFromReader odczytuje strumień .osm.pbf.
func ReadPBFFromReader(r io.Reader, cb Callbacks) error {
	lenBuf := make([]byte, 4)
	for {
		_, err := io.ReadFull(r, lenBuf)
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return err
		}
		headerSize := int(binary.BigEndian.Uint32(lenBuf))
		if headerSize <= 0 || headerSize > 64*1024 {
			return fmt.Errorf("nieprawidłowy rozmiar BlobHeader: %d", headerSize)
		}

		headerBytes := make([]byte, headerSize)
		if _, err := io.ReadFull(r, headerBytes); err != nil {
			return err
		}

		blobType, dataSize, err := parseBlobHeader(headerBytes)
		if err != nil {
			return err
		}
		if dataSize <= 0 || dataSize > 64*1024*1024 {
			return fmt.Errorf("nieprawidłowy rozmiar Blob: %d", dataSize)
		}

		blobBytes := make([]byte, dataSize)
		if _, err := io.ReadFull(r, blobBytes); err != nil {
			return err
		}

		if blobType != "OSMData" {
			continue
		}

		rawBlock, err := decodeBlob(blobBytes)
		if err != nil {
			return err
		}

		if err := parsePrimitiveBlock(rawBlock, cb); err != nil {
			return err
		}
	}
	return nil
}

func parseBlobHeader(b []byte) (blobType string, dataSize int, err error) {
	pos := 0
	for pos < len(b) {
		tag, n := readUvarint(b[pos:])
		if n <= 0 {
			return "", 0, fmt.Errorf("błąd odczytu tagu BlobHeader")
		}
		pos += n
		fieldNum := tag >> 3
		wireType := tag & 7

		switch wireType {
		case 0:
			val, vn := readUvarint(b[pos:])
			if vn <= 0 {
				return "", 0, fmt.Errorf("błąd varint w BlobHeader")
			}
			pos += vn
			if fieldNum == 3 {
				dataSize = int(val)
			}
		case 2:
			sub, sn := readLengthDelimited(b[pos:])
			if sn <= 0 {
				return "", 0, fmt.Errorf("błąd pola bajtowego w BlobHeader")
			}
			pos += sn
			if fieldNum == 1 {
				blobType = string(sub)
			}
		default:
			sn := skipField(b[pos:], wireType)
			if sn <= 0 {
				return "", 0, fmt.Errorf("nieznany wireType w BlobHeader: %d", wireType)
			}
			pos += sn
		}
	}
	return blobType, dataSize, nil
}

func decodeBlob(b []byte) ([]byte, error) {
	pos := 0
	var rawData []byte
	var zlibData []byte
	var rawSize int

	for pos < len(b) {
		tag, n := readUvarint(b[pos:])
		if n <= 0 {
			return nil, fmt.Errorf("błąd tagu w Blob")
		}
		pos += n
		fieldNum := tag >> 3
		wireType := tag & 7

		switch wireType {
		case 0:
			val, vn := readUvarint(b[pos:])
			if vn <= 0 {
				return nil, fmt.Errorf("błąd varint w Blob")
			}
			pos += vn
			if fieldNum == 2 {
				rawSize = int(val)
			}
		case 2:
			sub, sn := readLengthDelimited(b[pos:])
			if sn <= 0 {
				return nil, fmt.Errorf("błąd length-delimited w Blob")
			}
			pos += sn
			if fieldNum == 1 {
				rawData = sub
			} else if fieldNum == 3 {
				zlibData = sub
			}
		default:
			sn := skipField(b[pos:], wireType)
			if sn <= 0 {
				return nil, fmt.Errorf("błąd pomijania pola w Blob")
			}
			pos += sn
		}
	}

	if len(rawData) > 0 {
		return rawData, nil
	}
	if len(zlibData) > 0 {
		zr, err := zlib.NewReader(bytes.NewReader(zlibData))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		if rawSize > 0 && rawSize < 64*1024*1024 {
			out := make([]byte, rawSize)
			_, err := io.ReadFull(zr, out)
			if err == nil {
				return out, nil
			}
		}
		return io.ReadAll(zr)
	}
	return nil, fmt.Errorf("pusty blok Blob")
}

func parsePrimitiveBlock(b []byte, cb Callbacks) error {
	var stringTable []string
	var groups [][]byte
	granularity := int64(100)
	latOffset := int64(0)
	lonOffset := int64(0)

	pos := 0
	for pos < len(b) {
		tag, n := readUvarint(b[pos:])
		if n <= 0 {
			break
		}
		pos += n
		fieldNum := tag >> 3
		wireType := tag & 7

		switch wireType {
		case 0:
			val, vn := readUvarint(b[pos:])
			if vn <= 0 {
				return fmt.Errorf("błąd varint w PrimitiveBlock")
			}
			pos += vn
			switch fieldNum {
			case 17:
				granularity = int64(val)
			case 19:
				latOffset = int64(val)
			case 20:
				lonOffset = int64(val)
			}
		case 2:
			sub, sn := readLengthDelimited(b[pos:])
			if sn <= 0 {
				return fmt.Errorf("błąd length-delimited w PrimitiveBlock")
			}
			pos += sn
			switch fieldNum {
			case 1:
				stringTable = parseStringTable(sub)
			case 2:
				groups = append(groups, sub)
			}
		default:
			sn := skipField(b[pos:], wireType)
			if sn <= 0 {
				return fmt.Errorf("błąd pomijania w PrimitiveBlock")
			}
			pos += sn
		}
	}

	for _, g := range groups {
		parsePrimitiveGroup(g, stringTable, granularity, latOffset, lonOffset, cb)
	}
	return nil
}

func parseStringTable(b []byte) []string {
	var out []string
	pos := 0
	for pos < len(b) {
		tag, n := readUvarint(b[pos:])
		if n <= 0 {
			break
		}
		pos += n
		fieldNum := tag >> 3
		wireType := tag & 7
		if wireType == 2 {
			sub, sn := readLengthDelimited(b[pos:])
			if sn <= 0 {
				break
			}
			pos += sn
			if fieldNum == 1 {
				out = append(out, string(sub))
			}
		} else {
			sn := skipField(b[pos:], wireType)
			if sn <= 0 {
				break
			}
			pos += sn
		}
	}
	return out
}

func parsePrimitiveGroup(b []byte, st []string, granularity, latOffset, lonOffset int64, cb Callbacks) {
	pos := 0
	for pos < len(b) {
		tag, n := readUvarint(b[pos:])
		if n <= 0 {
			break
		}
		pos += n
		fieldNum := tag >> 3
		wireType := tag & 7

		if wireType != 2 {
			sn := skipField(b[pos:], wireType)
			if sn <= 0 {
				break
			}
			pos += sn
			continue
		}

		sub, sn := readLengthDelimited(b[pos:])
		if sn <= 0 {
			break
		}
		pos += sn

		switch fieldNum {
		case 1:
			if cb.OnNode != nil {
				if n, ok := parseSingleNode(sub, st, granularity, latOffset, lonOffset); ok {
					cb.OnNode(n)
				}
			}
		case 2:
			if cb.OnNode != nil {
				parseDenseNodes(sub, st, granularity, latOffset, lonOffset, cb.OnNode)
			}
		case 3:
			if cb.OnWay != nil {
				if w, ok := parseWay(sub, st); ok {
					cb.OnWay(w)
				}
			}
		case 4:
			if cb.OnRelation != nil {
				if r, ok := parseRelation(sub, st); ok {
					cb.OnRelation(r)
				}
			}
		}
	}
}

func parseSingleNode(b []byte, st []string, granularity, latOffset, lonOffset int64) (NodeData, bool) {
	var id, rawLat, rawLon int64
	var keys, vals []uint32
	pos := 0
	for pos < len(b) {
		tag, n := readUvarint(b[pos:])
		if n <= 0 {
			break
		}
		pos += n
		fieldNum := tag >> 3
		wireType := tag & 7
		switch wireType {
		case 0:
			val, vn := readUvarint(b[pos:])
			if vn <= 0 {
				return NodeData{}, false
			}
			pos += vn
			switch fieldNum {
			case 1:
				id = decodeZigZag(val)
			case 8:
				rawLat = decodeZigZag(val)
			case 9:
				rawLon = decodeZigZag(val)
			}
		case 2:
			sub, sn := readLengthDelimited(b[pos:])
			if sn <= 0 {
				return NodeData{}, false
			}
			pos += sn
			switch fieldNum {
			case 2:
				keys = unpackUint32(sub)
			case 3:
				vals = unpackUint32(sub)
			}
		default:
			sn := skipField(b[pos:], wireType)
			if sn <= 0 {
				return NodeData{}, false
			}
			pos += sn
		}
	}
	var tags map[string]string
	if len(keys) > 0 && len(keys) == len(vals) {
		tags = make(map[string]string, len(keys))
		for i := range keys {
			kIdx, vIdx := int(keys[i]), int(vals[i])
			if kIdx < len(st) && vIdx < len(st) {
				tags[st[kIdx]] = st[vIdx]
			}
		}
	}
	lat := 1e-9 * float64(latOffset+(granularity*rawLat))
	lon := 1e-9 * float64(lonOffset+(granularity*rawLon))
	return NodeData{ID: id, Lat: lat, Lon: lon, Tags: tags}, true
}

func parseDenseNodes(b []byte, st []string, granularity, latOffset, lonOffset int64, onNode func(NodeData)) {
	var idBytes, latBytes, lonBytes, kvBytes []byte
	pos := 0
	for pos < len(b) {
		tag, n := readUvarint(b[pos:])
		if n <= 0 {
			break
		}
		pos += n
		fieldNum := tag >> 3
		wireType := tag & 7
		if wireType == 2 {
			sub, sn := readLengthDelimited(b[pos:])
			if sn <= 0 {
				break
			}
			pos += sn
			switch fieldNum {
			case 1:
				idBytes = sub
			case 8:
				latBytes = sub
			case 9:
				lonBytes = sub
			case 10:
				kvBytes = sub
			}
		} else {
			sn := skipField(b[pos:], wireType)
			if sn <= 0 {
				break
			}
			pos += sn
		}
	}

	var curID, curLat, curLon int64
	idPos, latPos, lonPos, kvPos := 0, 0, 0, 0

	for idPos < len(idBytes) && latPos < len(latBytes) && lonPos < len(lonBytes) {
		dID, n1 := readUvarint(idBytes[idPos:])
		dLat, n2 := readUvarint(latBytes[latPos:])
		dLon, n3 := readUvarint(lonBytes[lonPos:])
		if n1 <= 0 || n2 <= 0 || n3 <= 0 {
			break
		}
		idPos += n1
		latPos += n2
		lonPos += n3

		curID += decodeZigZag(dID)
		curLat += decodeZigZag(dLat)
		curLon += decodeZigZag(dLon)

		var tags map[string]string
		for kvPos < len(kvBytes) {
			kIdx, nk := readUvarint(kvBytes[kvPos:])
			if nk <= 0 {
				kvPos = len(kvBytes)
				break
			}
			kvPos += nk
			if kIdx == 0 {
				break
			}
			vIdx, nv := readUvarint(kvBytes[kvPos:])
			if nv <= 0 {
				kvPos = len(kvBytes)
				break
			}
			kvPos += nv
			if tags == nil {
				tags = make(map[string]string)
			}
			if int(kIdx) < len(st) && int(vIdx) < len(st) {
				tags[st[int(kIdx)]] = st[int(vIdx)]
			}
		}

		lat := 1e-9 * float64(latOffset+(granularity*curLat))
		lon := 1e-9 * float64(lonOffset+(granularity*curLon))
		onNode(NodeData{
			ID:   curID,
			Lat:  lat,
			Lon:  lon,
			Tags: tags,
		})
	}
}

func parseWay(b []byte, st []string) (WayData, bool) {
	var id int64
	var keys, vals []uint32
	var refsBytes []byte
	pos := 0
	for pos < len(b) {
		tag, n := readUvarint(b[pos:])
		if n <= 0 {
			break
		}
		pos += n
		fieldNum := tag >> 3
		wireType := tag & 7
		switch wireType {
		case 0:
			val, vn := readUvarint(b[pos:])
			if vn <= 0 {
				return WayData{}, false
			}
			pos += vn
			if fieldNum == 1 {
				id = int64(val)
			}
		case 2:
			sub, sn := readLengthDelimited(b[pos:])
			if sn <= 0 {
				return WayData{}, false
			}
			pos += sn
			switch fieldNum {
			case 2:
				keys = unpackUint32(sub)
			case 3:
				vals = unpackUint32(sub)
			case 8:
				refsBytes = sub
			}
		default:
			sn := skipField(b[pos:], wireType)
			if sn <= 0 {
				return WayData{}, false
			}
			pos += sn
		}
	}

	var nodeIDs []int64
	var curRef int64
	rPos := 0
	for rPos < len(refsBytes) {
		dRef, n := readUvarint(refsBytes[rPos:])
		if n <= 0 {
			break
		}
		rPos += n
		curRef += decodeZigZag(dRef)
		nodeIDs = append(nodeIDs, curRef)
	}

	var tags map[string]string
	if len(keys) > 0 && len(keys) == len(vals) {
		tags = make(map[string]string, len(keys))
		for i := range keys {
			kIdx, vIdx := int(keys[i]), int(vals[i])
			if kIdx < len(st) && vIdx < len(st) {
				tags[st[kIdx]] = st[vIdx]
			}
		}
	}
	return WayData{ID: id, NodeIDs: nodeIDs, Tags: tags}, true
}

func parseRelation(b []byte, st []string) (RelationData, bool) {
	var id int64
	var keys, vals, rolesIdx, typesList []uint32
	var memidsBytes []byte
	pos := 0
	for pos < len(b) {
		tag, n := readUvarint(b[pos:])
		if n <= 0 {
			break
		}
		pos += n
		fieldNum := tag >> 3
		wireType := tag & 7
		switch wireType {
		case 0:
			val, vn := readUvarint(b[pos:])
			if vn <= 0 {
				return RelationData{}, false
			}
			pos += vn
			if fieldNum == 1 {
				id = int64(val)
			}
		case 2:
			sub, sn := readLengthDelimited(b[pos:])
			if sn <= 0 {
				return RelationData{}, false
			}
			pos += sn
			switch fieldNum {
			case 2:
				keys = unpackUint32(sub)
			case 3:
				vals = unpackUint32(sub)
			case 8:
				rolesIdx = unpackUint32(sub)
			case 9:
				memidsBytes = sub
			case 10:
				typesList = unpackUint32(sub)
			}
		default:
			sn := skipField(b[pos:], wireType)
			if sn <= 0 {
				return RelationData{}, false
			}
			pos += sn
		}
	}

	var memIDs []int64
	var curMem int64
	mPos := 0
	for mPos < len(memidsBytes) {
		dMem, n := readUvarint(memidsBytes[mPos:])
		if n <= 0 {
			break
		}
		mPos += n
		curMem += decodeZigZag(dMem)
		memIDs = append(memIDs, curMem)
	}

	var members []RelationMember
	for i := 0; i < len(memIDs); i++ {
		role := ""
		if i < len(rolesIdx) && int(rolesIdx[i]) < len(st) {
			role = st[int(rolesIdx[i])]
		}
		mType := 0
		if i < len(typesList) {
			mType = int(typesList[i])
		}
		members = append(members, RelationMember{
			ID:   memIDs[i],
			Type: mType,
			Role: role,
		})
	}

	var tags map[string]string
	if len(keys) > 0 && len(keys) == len(vals) {
		tags = make(map[string]string, len(keys))
		for i := range keys {
			kIdx, vIdx := int(keys[i]), int(vals[i])
			if kIdx < len(st) && vIdx < len(st) {
				tags[st[kIdx]] = st[vIdx]
			}
		}
	}
	return RelationData{ID: id, Members: members, Tags: tags}, true
}

func readUvarint(b []byte) (uint64, int) {
	var x uint64
	var s uint
	for i, byt := range b {
		if i >= 10 {
			return 0, -1
		}
		if byt < 0x80 {
			return x | uint64(byt)<<s, i + 1
		}
		x |= uint64(byt&0x7f) << s
		s += 7
	}
	return 0, -1
}

func decodeZigZag(n uint64) int64 {
	return int64((n >> 1) ^ uint64((int64(n&1)<<63)>>63))
}

func readLengthDelimited(b []byte) ([]byte, int) {
	length, n := readUvarint(b)
	if n <= 0 {
		return nil, -1
	}
	end := n + int(length)
	if end < n || end > len(b) {
		return nil, -1
	}
	return b[n:end], end
}

func skipField(b []byte, wireType uint64) int {
	switch wireType {
	case 0:
		_, n := readUvarint(b)
		return n
	case 1:
		if len(b) < 8 {
			return -1
		}
		return 8
	case 2:
		_, n := readLengthDelimited(b)
		return n
	case 5:
		if len(b) < 4 {
			return -1
		}
		return 4
	default:
		return -1
	}
}

func unpackUint32(b []byte) []uint32 {
	var out []uint32
	pos := 0
	for pos < len(b) {
		v, n := readUvarint(b[pos:])
		if n <= 0 {
			break
		}
		pos += n
		out = append(out, uint32(v))
	}
	return out
}

