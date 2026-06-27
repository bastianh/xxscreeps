export const ResourceType = {
	"enum": [ undefined, "energy", "power", "H", "O", "U", "L", "K", "Z", "X", "G", "OH", "ZK", "UL", "UH", "UO", "KH", "KO", "LH", "LO", "ZH", "ZO", "GH", "GO", "UH2O", "UHO2", "KH2O", "KHO2", "LH2O", "LHO2", "ZH2O", "ZHO2", "GH2O", "GHO2", "XUH2O", "XUHO2", "XKH2O", "XKHO2", "XLH2O", "XLHO2", "XZH2O", "XZHO2", "XGH2O", "XGHO2", "utrium_bar", "lemergium_bar", "zynthium_bar", "keanium_bar", "ghodium_melt", "oxidant", "reductant", "purifier", "battery", "silicon", "metal", "biomass", "mist", "ops", "composite", "crystal", "liquid", "wire", "switch", "transistor", "microchip", "circuit", "device", "cell", "phlegm", "tissue", "muscle", "organoid", "organism", "alloy", "tube", "fixtures", "frame", "hydraulics", "machine", "condensate", "concentrate", "extract", "spirit", "emanation", "essence" ],
};
export const OpenStore = {
	"struct": {
		"#capacity": { "member": "int32", "offset": 0x8 },
		"#resources": {
			"offset": 0x0,
			"member": {
				"align": 4,
				"size": 5,
				"stride": 8,
				"vector": {
					"struct": {
						"amount": { "member": "int32", "offset": 0x0 },
						"type": { "member": ResourceType, "offset": 0x4 },
					},
				},
			},
		},
	},
};
export default OpenStore;
