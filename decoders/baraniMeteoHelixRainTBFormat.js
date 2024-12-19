// Special case Payload Decoder for Barani meteoHelix+meteoRain for Milesight network server (aka Chirpstack format)
// Time-stamp: <2024-12-18 18:31:13 rytis>
// Authors:
// Marco Rainone
// Rytis Paškauskas
// ------------------------------------------------
// Meteorological variable short name descriptions:
//
// t: average (10 min) temperature
// tm: lowest (10 min) temperature
// tx: highest (10 min) temperature
// h: average (10 min) relative humidity
// p: average (10 min) barometric pressure,
// s: average (10 min) solar irradiation
// sx: highest solar irratiation
// ws: average (10 min) horizontal scalar wind speed
// wsx: maximum (V9) or WMO gust (V10 and V12) wind speed. WMO: maximum rolling 3 second average wind speed
// wsm: minimum (V9) or WMO min (V10 and V12) wind speed. WMO: calculated over rolling 3 second average
// wssd: wind speed standard deviation
// wd: average (10 min) horizontal wind direction
// wdx: direction corresponding to wsx [maximum (V9) or WMO max (V10 and V12)]
// wdsd: wind direction standard deviation
// rc: rain counter (counts tipping bucket flips)
// rcc: rain intenisty correction (additive to rc)
// ------------------------------------------------------------
// wxt: wind-related mysterious variable
// https://www.wind101.net/COM_type_03/IoT_Wind_ALLMETEO_Data_Message_Format_Decoder.htm)
// rx: rain-related mysterious and probably junk variable
//
// Notes:
// Wind variables across V9 and V10 or V12 have similar notation but possibly different meanings.
// That's because V9 specifies max and min as absolute, whereas V10/12 specify as 3 second rolling averages.
// Likewise, V9 provides dir_hi and dir_lo, whereas V12 specifies the standard deviation.
// However, dir_hi and -dir_lo are defined so as to make dir_hi-dir_lo == standard deviation. 

function Decode(fPort, bytes)
{
    var pos = 0;
    var bindata = "";
    
    // -----------------------------------------------------
    // Functions
    function byteToHex(byteArray) {
	var hexString = '';
	for (var i = 0; i < byteArray.length; i++) {
	    var hex = byteArray[i].toString(16);
	    hex = (hex.length === 1) ? '0' + hex : hex;
	    hexString += hex;
	}
	return hexString;
    }

    var ConvertBase = function (num) {
	return {
	    from : function (baseFrom) {
		return {
	            to : function (baseTo) {
			return parseInt(num, baseFrom).toString(baseTo);
	            }
		};
	    }
	};
    };

    function pad(num) {
	var s = "0000000" + num;
	return s.slice(-8);
    }

    ConvertBase.dec2bin = function (num) {
	return pad(ConvertBase(num).from(10).to(2));
    };
    
    ConvertBase.bin2dec = function (num) {
	return ConvertBase(num).from(2).to(10);
    };

    function data2bits(data) {
	var binary = "";
	for(var i=0; i<data.length; i++) {
	    binary += ConvertBase.dec2bin(data[i]);
	}
	return binary;
    }

    function bitShift(bits) {
	var num = ConvertBase.bin2dec(bindata.substr(pos, bits));
	pos += bits;
	return Number(num);
    }

    function precisionRound(number, precision) {
	var factor = Math.pow(10, precision);
	return Math.round(number * factor) / factor;
    }

    // timestamp to unix time with milliseconds.
    function decodeMilesightTimestamp(dateString) {
	var date = new Date(dateString);
	var msec = date.getTime();
	// TODO: improve exception handling
	if (isNaN(msec)) {
	    msec = 0;
	    //     throw new Error("Invalid format: " + dateString);
	}
	return msec;
    }
    
    var msg = {};
    var values = {};
    var asset_type;
    var decoded;
    var obj = LoRaObject;
    
    // ts: Transmitter unix timestamp with milliseconds (first field)
    // if not available, we omit 'ts' and omit 'values' field later. 
    // This way the payload can still be handled by TB
    if(obj) {
	var dateString = obj.time;
	if (dateString.length>=19) {
	    msg.ts = decodeMilesightTimestamp(dateString);
	}
    }

    bindata = data2bits(bytes);
    // convert payload to string
    hex = byteToHex(bytes);

    // Start decoding here:
    if (bytes.length === 11 && fPort === 1) { // HelixRain
	// https://www.baranidesign.com/meteohelix-message-decoder
	asset_type = "meteoHelixRain";
	Type =  bitShift(2);
	Battery = precisionRound(bitShift(5)*0.05+3, 2);
	Temperature = precisionRound(bitShift(11)*0.1-100, 1);
	T_min = precisionRound(Temperature - bitShift(6)*0.1, 1);
	T_max = precisionRound(Temperature + bitShift(6)*0.1, 1);
	Humidity = precisionRound(bitShift(9)*0.2, 1);
	Pressure = bitShift(14)*5+50000;
	Irradiation = bitShift(10)*2;
	Irr_max = Irradiation + bitShift(9)*2;
	Rain = precisionRound(bitShift(8), 1);
	Rain_time = precisionRound(bitShift(8), 1);
	
	// 2024-12-06 Rytis: see notion notes (Gateway Network Server->Payload codec)
	// In short, I think that Rain_time has a mistake. Also it is not useful by itself.
	// I provide a rx value, which is my best guess at what the actual value should be.
	//var rx = Rain_time + 1;
	//if (Rain_time === 255) {
	//   rx = 0;
	//} else {
	//   rx = 19.78*rx;
	//}
	// Update: 
	// The newer devices some random value, 252 when there is no rain.
	// So it all falls apart. I think this is just junk value.
	//var rx = Rain_time;
	// Update: 
	// Handle meteoHelix with Rain attached separately, assigning a different asset name
	// This will probably need a separate payload decoder (because the two are 
	// indistinguishable by payload length). But that's OK, since decoders can 
	// set on a per-device basis.
	
	decoded = {
	    "type": Type,
	    "batt": Battery,
	    "t": Temperature,
	    "tm": T_min,
	    "tx": T_max,
	    "h": Humidity,
	    "p": Pressure,
	    "s": Irradiation,
	    "sx": Irr_max,
	    "rc": Rain,
	    "rx": Rain_time
	};
    } else if ( ((bytes.length === 10) || (bytes.length === 12) )  && fPort === 1 ) {
	//===================================================================
	// MeteoWind (10 or 12 bytes payload)
	// Based on 2022 open-source decoder
	// Sources: 
	// https://www.wind101.net/COM_type_03/IoT_Wind_ALLMETEO_Data_Message_Format_Decoder.htm
	// https://www.baranidesign.com/s/2022_MeteoWind_IoT_Index_10Byte_BARANI_Message_Format_locked.xlsx
	if (bytes.length === 10) {
	    asset_type = "meteoWindV10";
	} else {
	    asset_type = "meteoWindV12";
	}
	Index = precisionRound(bitShift(8)*1, 1);
	Battery = precisionRound(bitShift(3)*0.2+3, 1);
	Wind_ave = precisionRound(bitShift(9)*0.1, 1);
	Wind_3sgust = precisionRound(Wind_ave + bitShift(9)*0.1, 1);
	Wind_3smin = precisionRound(Wind_ave - bitShift(9)*0.1, 1);
	Wind_stdev = precisionRound(bitShift(8)*0.1, 1);
	Dir_ave = precisionRound(bitShift(9)*1, 1);
	Dir_3sgust = precisionRound(bitShift(9)*1, 1);
	Dir_stdev = precisionRound(bitShift(7)*1, 1);
	Gust_time = precisionRound(bitShift(7)*5, 1);
	Vector_scalar = precisionRound(bitShift(1)*1, 1);
	Alarm_sent = precisionRound(bitShift(1)*1, 1); 

	decoded = {
	    "idx": Index,
	    "batt": Battery,
	    "ws": Wind_ave,	// mean (average) wind speed for the 10 minute interval
	    "wsx": Wind_3sgust,	// gust value per WMO (maximum rolling 3 second average wind speed)
	    "wsm": Wind_3smin,	// minimum rolling 3 second average wind speed.
	    "wssd": Wind_stdev,	// the wind speed standard deviation.
	    "wd": Dir_ave, // mean (average) wind direction for the 10 minute interval.
	    "wdx": Dir_3sgust, // wind direction corresponding to the maximum gust wind speed (wsx).
	    "wdsd": Dir_stdev, // wind direction standard deviation.
	    "wxt": Gust_time,  // elapsed time in multiple of seconds after start of logging interval, time resolution = 5 sec. 
	    "isVector": Vector_scalar, // Vector/Scalar value of wind speed & direction,  Scalar=0(default), Vector =1.
	    "alarm": Alarm_sent,     // whether alarm was activated during the current time interval:
	    // 0 (default) : alarm was not sent during the last logging interval
	    // 1 at least one alarm was sent during the last logging interval.
	};
    } else if (bytes.length === 9  && fPort === 1) {
	//===================================================================
	// MeteoWind (9 byte payload)
	// Based on 2021 Open-Source Decoder
	// https://www.baranidesign.com/iot-wind-open-message-format
	asset_type = "meteoWindV9";
	Type =  bitShift(2);
	Battery = precisionRound(bitShift(5)*0.05+3, 1);
	Wind_ave10 = precisionRound(bitShift(9)*0.1, 1);
	Wind_max10 = precisionRound(Wind_ave10 + bitShift(9)*0.1, 1);
	Wind_min10 = precisionRound(Wind_ave10 - bitShift(9)*0.1, 1);
	Dir_ave10 = precisionRound(bitShift(9)*1, 1);
	Dir_max10 = precisionRound(bitShift(9)*1, 1);
	Dir_hi10 = precisionRound(bitShift(8)*1, 1);
	Dir_lo10 = precisionRound(bitShift(8)*1, 1);

	var wdsd = 0.0;
	if (Dir_hi10 >= 0 && Dir_lo10 >=0 ) {
	    wdsd = Dir_hi10 + Dir_lo10;
	} else {
	    if (Dir_hi10 >= Dir_lo10) {
		wdsd = Dir_hi10 - Dir_lo10;
	    } else {
		wdsd = 360 + Dir_hi10 - Dir_lo10;
	    }
	}
	decoded = {
	    "type": Type,
	    "batt": Battery,
	    "ws": Wind_ave10, // mean (average) wind speed for the 10 minute interval
	    "wsx": Wind_max10, // max wind speed (gust) value
	    "wsm": Wind_min10, // min wind speed 
	    "wd": Dir_ave10,   // mean (average) wind direction for the 10 minute interval
	    "wdx": Dir_max10, // the wind direction corresponding to the maximum gust wind speed (wsx)
	    // wdhi and wdlo: These values set the range of wind directions to the
	    // right and left of the mean wind value (wd), in between which
	    // 68.2% wind speeds occured during the sampling time (10 minutes).
	    // "wdhi": Dir_hi10,
	    // "wdlo": Dir_lo10,
	    "wdsd": wdsd	// wind direction standard deviation
	};
    } else if (bytes.length === 6  && fPort === 1) {
	// This is meteoRain, but we can't distinguish it from HelixRain, therefore we should throw an error.
	asset_type = "unknownBarani";
	decoded = {
	    "length": bytes.length,
	    "port": fPort,
	    "payloadHex": hex,
	    "info": "Suspected duplication of rain parameters. Use baraniMeteoHelixTBFormat for autonomous meteoRain and baraniMeteoHelixRainTBFormat for Helix-cable-Rain. Cannot have both"
	};

	// //===================================================================
	// // METEORAIN (6 byte payload)
	// // Based on Open-Source Decoder
	// // https://www.baranidesign.com/meteorain-open-message-format
	// asset_type = "meteoRain";
	// Index = bitShift(8);
	// Battery = precisionRound(bitShift(5)*0.05+3, 2);
	// Rain = precisionRound(bitShift(12), 1);
	// Rain_time = precisionRound(bitShift(8), 1);
	// Frost_alert = precisionRound(bitShift(1)*1, 0);
	// Heater_on = precisionRound(bitShift(1)*1, 0);
	// RainIntensityCorrection = precisionRound(bitShift(12)*0.01,2);
	
	// // 2024-12-06 Rytis: see notion notes (Gateway Network Server->Payload codec)
	// // In short, I think that Rain_time has a mistake. Also it is not useful by itself.
	// // I provide a rx value, which is my best guess at what the actual value should be.
	// //var rx = Rain_time + 1;
	// //if (Rain_time === 255) {
	// //   rx = 0;
	// //} else {
	// //   rx = 19.78*rx;
	// //}
	// // Update: 
	// // The newer devices some random value, 252 when there is no rain.
	// // So it all falls apart. I think this is just junk value.
	// // var rx = Rain_time;
	
	// decoded = {
	//     "idx": Index,
	//     "batt": Battery,
	//     "rc": Rain,		// tipping bucket flip counter
	//     "rcc": RainIntensityCorrection, // correction for high intensity rain
	//     "rx": Rain_time,		    // unidentified junk value
	//     "frost": Frost_alert,
	//     "heater": Heater_on,
	// };
    } else {
	//===================================================================
	// The payload length/port do not match any Barani device.
	asset_type = "unknownBarani";
	decoded = {
	    "length": bytes.length,
	    "port": fPort,
	    "payloadHex": hex
	};
    }
    
    values = {
	"instrumentClass": asset_type,
	"sensorData": decoded,
	"payloadHex": hex
    };
    
    if( obj ) {
	values.lora=obj;
    }
    
    if (msg.hasOwnProperty('ts')) {
	msg.values = values;
    } else {
	msg = values;
    }
    return msg;
}
