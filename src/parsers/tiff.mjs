import {AppSegment, parsers} from './core.mjs'
import {tags} from '../tags.mjs'
import {TAG_IFD_EXIF, TAG_IFD_GPS, TAG_IFD_INTEROP} from '../tags.mjs'
import {slice, BufferView} from '../util/BufferView.mjs'
import {translateValue, reviveDate, ConvertDMSToDD} from './tiff-tags.mjs'


export const TIFF_LITTLE_ENDIAN = 0x4949
export const TIFF_BIG_ENDIAN    = 0x4D4D

const THUMB_OFFSET  = 0x0201
const THUMB_LENGTH  = 0x0202

const SIZE_LOOKUP = {
	1: 1, // BYTE      - 8-bit unsigned integer
	2: 1, // ASCII     - 8-bit bytes w/ last byte null
	3: 2, // SHORT     - 16-bit unsigned integer
	4: 4, // LONG      - 32-bit unsigned integer
	5: 8, // RATIONAL  - 64-bit unsigned fraction
	6: 1, // SBYTE     - 8-bit signed integer
	7: 1, // UNDEFINED - 8-bit untyped data
	8: 2, // SSHORT    - 16-bit signed integer
	9: 4, // SLONG     - 32-bit signed integer
	10: 8, // SRATIONAL - 64-bit signed fraction (Two 32-bit signed integers)
	11: 4, // FLOAT,    - 32-bit IEEE floating point
	12: 8, // DOUBLE    - 64-bit IEEE floating point
	// https://sno.phy.queensu.ca/~phil/exiftool/standards.html
	13: 4 // IFD (sometimes used instead of 4 LONG)
}


const blockKeys = ['ifd0', 'exif', 'gps', 'interop', 'thumbnail']

// jpg wraps tiff into app1 segment.
export class TiffCore extends AppSegment {

	parseHeader() {
		// Detect endian 11th byte of TIFF (1st after header)
		var byteOrder = this.view.getUint16()
		if (byteOrder === TIFF_LITTLE_ENDIAN)
			this.le = true // little endian
		else if (byteOrder === TIFF_BIG_ENDIAN)
			this.le = false // big endian
		else
			throw new Error('Invalid EXIF data: expected byte order marker (0x4949 or 0x4D4D).')
		this.view.le = this.le

		// Bytes 8 & 9 are expected to be 00 2A.
		if (this.view.getUint16(2) !== 0x002A)
			throw new Error('Invalid EXIF data: expected 0x002A.')
	}

	parseTags(offset) {
		let entriesCount = this.view.getUint16(offset)
		offset += 2
		let {pickTags, skipTags} = this.options
		let output = {}
		for (let i = 0; i < entriesCount; i++) {
			let tag = this.view.getUint16(offset)
			if (pickTags.includes(tag) || !skipTags.includes(tag)) {
				let val = this.parseTag(offset)
				output[tag] = val
			}
			offset += 12
		}
		return output
	}

	parseTag(offset) {
		let type = this.view.getUint16(offset + 2)
		let valuesCount = this.view.getUint32(offset + 4)
		let valueByteSize = SIZE_LOOKUP[type]
		if (valueByteSize * valuesCount <= 4)
			var valueOffset = offset + 8
		else
			var valueOffset = this.view.getUint32(offset + 8)

		if (valueOffset > this.view.buffer.byteLength)
			throw new Error(`tiff value offset ${valueOffset} is out of chunk size ${this.view.buffer.byteLength}`)

		// ascii strings, array of 8bits/1byte values.
		if (type === 2) {
			let string = this.view.getString(valueOffset, valuesCount)
			// remove null terminator
			while (string.endsWith('\0')) string = string.slice(0, -1)
			return string
		}

		// undefined/buffers of 8bit/1byte values.
		if (type === 7)
			return slice(this.view, valueOffset, valueOffset + valuesCount)

		// Now that special cases are solved, we can return the normal uint/int value(s).
		if (valuesCount === 1) {
			// Return single value.
			return this.parseTagValue(type, valueOffset)
		} else {
			// Return array of values.
			let res = []
			for (let i = 0; i < valuesCount; i++) {
				res.push(this.parseTagValue(type, valueOffset))
				valueOffset += valueByteSize
			}
			return res
		}
	}

	parseTagValue(type, offset) {
		switch (type) {
			case 1:  return this.view.getUint8(offset)
			case 3:  return this.view.getUint16(offset)
			case 4:  return this.view.getUint32(offset)
			case 5:  return this.view.getUint32(offset) / this.view.getUint32(offset + 4)
			case 6:  return this.view.getInt8(offset)
			case 8:  return this.view.getInt16(offset)
			case 9:  return this.view.getInt32(offset)
			case 10: return this.view.getInt32(offset) / this.view.getInt32(offset + 4)
			case 11: return this.view.getFloat(offset)
			case 12: return this.view.getDouble(offset)
			case 13: return this.view.getUint32(offset)
			default: throw new Error(`Invalid tiff type ${type}`)
		}
	}

}










/*
JPEG with EXIF segment starts with App1 header (FF E1, length, 'Exif\0\0') and then follows the TIFF.
Whereas .tif file format starts with the TIFF structure right away.

APP1 HEADER (only in JPEG)
- FF E1 - segment marker
- 2Bytes - segment length
- 45 78 69 66 00 00 - string 'Exif\0\0'

APP1 CONTENT
- TIFF HEADER (2b byte order, 2b tiff id, 4b offset of ifd1)
- IFD0
- Exif IFD
- Interop IFD
- GPS IFD
- IFD1
*/
export class Tiff extends TiffCore {

	static type = 'tiff'
	static mergeOutput = true
	static headerLength = 10

	// .tif files do no have any APPn segments. and usually start right with TIFF header
	// .jpg files can have multiple APPn segments. They always have APP1 whic is a wrapper for TIFF.
	// We support both jpg and tiff so we're not looking for app1 segment but directly for TIFF
	// because app1 in jpg is only container for tiff.
	static canHandle(view, offset) {
		return view.getUint8(offset + 1) === 0xE1
			&& view.getUint32(offset + 4) === 0x45786966 // 'Exif'
			&& view.getUint16(offset + 8) === 0x0000     // followed by '\0'
	}

	// APP1 includes TIFF formatted values, grouped into IFD blocks (IFD0, Exif, Interop, GPS, IFD1)
	async parse() {
		this.parseHeader()
		this.parseIfd0Block()                                  // APP1 - IFD0
		if (this.options.exif)      this.parseExifBlock()      // APP1 - EXIF IFD
		if (this.options.gps)       this.parseGpsBlock()       // APP1 - GPS IFD
		if (this.options.interop)   this.parseInteropBlock()   // APP1 - Interop IFD
		if (this.options.thumbnail) this.parseThumbnailBlock() // APP1 - IFD1
		this.postProcess()
		let {ifd0, exif, gps, interop, thumbnail} = this
		if (this.options.mergeOutput)
			this.output = Object.assign({}, ifd0, exif, gps, interop, thumbnail)
		else {
			//this.output = {ifd0, exif, gps, interop, thumbnail}
			this.output = {}
			for (let key of blockKeys) {
				let blockOutput = this[key]
				if (blockOutput) this.output[key] = blockOutput
			}
		}
		return this.output
	}

	parseIfd0Block() {
		if (this.ifd0) return
		// Read the IFD0 segment with basic info about the image
		// (width, height, maker, model and pointers to another segments)
		this.ifd0Offset = this.view.getUint32(4)
		if (this.ifd0Offset < 8)
			throw new Error('Invalid EXIF data: IFD0 offset should be less than 8')
		// Parse IFD0 block.
		this.ifd0 = this.parseTags(this.ifd0Offset)
		// Cancel if the ifd0 is empty (imaged created from scratch in photoshop).
		if (Object.keys(this.ifd0).length === 0) return
		// Store offsets of other blocks in the TIFF segment.
		this.exifOffset    = this.ifd0[TAG_IFD_EXIF]
		this.interopOffset = this.ifd0[TAG_IFD_INTEROP]
		this.gpsOffset     = this.ifd0[TAG_IFD_GPS]
		// IFD0 segment also contains offset pointers to another segments deeper within the EXIF.
		// User doesn't need to see this. But we're sanitizing it only if options.postProcess is enabled.
		if (this.options.sanitize) {
			delete this.ifd0[TAG_IFD_EXIF]
			delete this.ifd0[TAG_IFD_INTEROP]
			delete this.ifd0[TAG_IFD_GPS]
		}
	}

	// EXIF block of TIFF of APP1 segment
	// 0x8769
	parseExifBlock() {
		if (this.exif) return
		if (this.exifOffset === undefined) return
		this.exif = this.parseTags(this.exifOffset)
	}

	// GPS block of TIFF of APP1 segment
	// 0x8825
	parseGpsBlock() {
		if (this.gps) return
		if (this.gpsOffset === undefined) return
		this.gps = this.parseTags(this.gpsOffset)
	}

	// INTEROP block of TIFF of APP1 segment
	// 0xA005
	parseInteropBlock() {
		if (this.interop) return
		this.interopOffset = this.interopOffset || (this.exif && this.exif[TAG_IFD_INTEROP])
		if (this.interopOffset === undefined) return
		this.interop = this.parseTags(this.interopOffset)
	}

	// THUMBNAIL block of TIFF of APP1 segment
	// returns boolean "does the file contain thumbnail"
	parseThumbnailBlock(force = false) {
		if (this.thumbnail || this.thumbnailParsed) return
		if (this.options.mergeOutput && !force) return false
		let ifd0Entries = this.view.getUint16(this.ifd0Offset)
		let temp = this.ifd0Offset + 2 + (ifd0Entries * 12)
		// IFD1 offset is number of bytes from start of TIFF header where thumbnail info is.
		this.ifd1Offset = this.view.getUint32(temp)
		if (this.ifd1Offset === 0) return false
		this.thumbnail = this.parseTags(this.ifd1Offset)
		this.thumbnailParsed = true
		return true
	}

	// THUMBNAIL buffer of TIFF of APP1 segment
	extractThumbnail() {
		this.parseHeader()
		if (!this.ifd0) this.parseIfd0Block(true)
		if (!this.thumbnailParsed) this.parseThumbnailBlock(true)
		if (this.thumbnail === undefined) return 
		// TODO: replace 'ThumbnailOffset' & 'ThumbnailLength' by raw keys (when tag dict is not included)
		let offset = this.thumbnail[THUMB_OFFSET]
		let length = this.thumbnail[THUMB_LENGTH]
		let subView = this.view.subarray(offset, length)
		if (typeof Buffer !== 'undefined')
			return Buffer.from(subView.buffer)
		else
			return subView.buffer
	}

	postProcess() {
		let {postProcess, translateTags, reviveValues} = this.options
		if (!postProcess) return
		let gps = this.gps
		if (gps && gps[GPS_LAT] && gps[GPS_LON]) {
			gps.latitude  = ConvertDMSToDD(...gps[GPS_LAT], gps[GPS_LATREF])
			gps.longitude = ConvertDMSToDD(...gps[GPS_LON], gps[GPS_LONREF])
		}
		if (translateTags || reviveValues) {
			for (let key of blockKeys) {
				let dictionary = tags.tiff[key]
				let rawTags = this[key]
				if (rawTags === undefined) continue
				let entries = Object.entries(this[key])
				if (reviveValues)
					entries = entries.map(([tag, val]) => [tag, translateValue(tag, val)])
				if (translateTags)
					entries = entries.map(([tag, val]) => [dictionary[tag] || tag, val])
				this[key] = Object.fromEntries(entries)
			}
		}
	}

}

export const GPS_LATREF = 0x0001
export const GPS_LAT    = 0x0002
export const GPS_LONREF = 0x0003
export const GPS_LON    = 0x0004


parsers.tiff = Tiff
