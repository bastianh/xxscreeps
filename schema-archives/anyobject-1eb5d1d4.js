export const ActionLog = {
	"align": 4,
	"size": 7,
	"stride": 8,
	"vector": {
		"struct": {
			"time": { "member": "int32", "offset": 0x0 },
			"x": { "member": "int8", "offset": 0x5 },
			"y": { "member": "int8", "offset": 0x6 },
			"type": {
				"offset": 0x4,
				"member": {
					"enum": [ "harvest", "reaction1", "reaction2", "reverseReaction1", "reverseReaction2", "attack", "attacked", "heal", "healed", "rangedAttack", "rangedHeal", "rangedMassAttack", "build", "repair", "produce", "transferEnergy", "reserveController", "upgradeController" ],
				},
			},
		},
	},
};
export const Id = { "array": "uint32", "length": 4, "stride": 4 };
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
export const RoomPosition = { "layout": "int32", "named": "RoomPosition" };
export const RoomObject = {
	"struct": {
		"#posId": { "member": "int32", "offset": 0x10, "union": true },
		"id": { "member": Id, "offset": 0x0 },
		"pos": { "member": RoomPosition, "offset": 0x10 },
	},
};
export const ConstructionSite = {
	"inherit": RoomObject,
	"variant": "constructionSite",
	"struct": {
		"#user": { "member": Id, "offset": 0x14 },
		"name": { "member": "string", "offset": 0x24 },
		"progress": { "member": "int32", "offset": 0x2c },
		"progressTotal": { "member": "int32", "offset": 0x30 },
		"structureType": {
			"offset": 0x34,
			"member": {
				"enum": [ "container", "extractor", "lab", "rampart", "tower", "constructedWall", "factory", "link", "storage", "terminal", "nuker", "observer", "powerSpawn", "road", "extension", "spawn" ],
			},
		},
	},
};
export const Creep = {
	"inherit": RoomObject,
	"variant": "creep",
	"struct": {
		"#actionLog": { "member": ActionLog, "offset": 0x30 },
		"#ageTime": { "member": "int32", "offset": 0x48 },
		"#noAttackNotify": { "member": "bool", "offset": 0x58 },
		"#user": { "member": Id, "offset": 0x14 },
		"fatigue": { "member": "int32", "offset": 0x50 },
		"hits": { "member": "int32", "offset": 0x54 },
		"name": { "member": "string", "offset": 0x40 },
		"store": { "member": OpenStore, "offset": 0x24 },
		"#saying": {
			"offset": 0x4c,
			"member": {
				"align": 4,
				"size": 13,
				"pointer": {
					"struct": {
						"isPublic": { "member": "bool", "offset": 0xc },
						"message": { "member": "string", "offset": 0x0 },
						"time": { "member": "int32", "offset": 0x8 },
					},
				},
			},
		},
		"body": {
			"offset": 0x38,
			"member": {
				"align": 1,
				"size": 3,
				"stride": 3,
				"vector": {
					"struct": {
						"boost": { "member": ResourceType, "offset": 0x0 },
						"hits": { "member": "int8", "offset": 0x1 },
						"type": {
							"offset": 0x2,
							"member": {
								"enum": [ "move", "work", "carry", "attack", "ranged_attack", "tough", "heal", "claim" ],
							},
						},
					},
				},
			},
		},
	},
};
export const Deposit = {
	"inherit": RoomObject,
	"variant": "deposit",
	"struct": {
		"#cooldownTime": { "member": "int32", "offset": 0x14 },
		"#harvested": { "member": "int32", "offset": 0x18 },
		"#nextDecayTime": { "member": "int32", "offset": 0x1c },
		"depositType": { "member": ResourceType, "offset": 0x24 },
		"lastCooldown": { "member": "int32", "offset": 0x20 },
	},
};
export const Mineral = {
	"inherit": RoomObject,
	"variant": "mineral",
	"struct": {
		"#nextRegenerationTime": { "member": "int32", "offset": 0x14 },
		"density": { "member": "int32", "offset": 0x18 },
		"mineralAmount": { "member": "int32", "offset": 0x1c },
		"mineralType": { "member": ResourceType, "offset": 0x20 },
	},
};
export const Nuke = {
	"inherit": RoomObject,
	"variant": "nuke",
	"struct": {
		"#landTime": { "member": "int32", "offset": 0x1c },
		"#launchRoomName": { "member": "string", "offset": 0x14 },
	},
};
export const ObserverSpy = {
	"inherit": RoomObject,
	"variant": "ObserverSpy",
	"struct": {
		"#user": { "member": Id, "offset": 0x14 },
	},
};
export const Resource = {
	"inherit": RoomObject,
	"variant": "resource",
	"struct": {
		"amount": { "member": "int32", "offset": 0x14 },
		"resourceType": { "member": ResourceType, "offset": 0x18 },
	},
};
export const Ruin = {
	"inherit": RoomObject,
	"variant": "ruin",
	"struct": {
		"#decayTime": { "member": "int32", "offset": 0x4c },
		"destroyTime": { "member": "int32", "offset": 0x50 },
		"store": { "member": OpenStore, "offset": 0x40 },
		"#structure": {
			"offset": 0x14,
			"member": {
				"struct": {
					"hitsMax": { "member": "int32", "offset": 0x28 },
					"id": { "member": Id, "offset": 0x0 },
					"type": { "member": "string", "offset": 0x20 },
					"user": { "member": Id, "offset": 0x10 },
				},
			},
		},
	},
};
export const SingleStore = {
	"struct": {
		"#amount": { "member": "int32", "offset": 0x0 },
		"#capacity": { "member": "int32", "offset": 0x4 },
		"#type": { "member": ResourceType, "offset": 0x8 },
	},
};
export const Source = {
	"inherit": RoomObject,
	"variant": "source",
	"struct": {
		"#nextRegenerationTime": { "member": "int32", "offset": 0x14 },
		"energy": { "member": "int32", "offset": 0x18 },
		"energyCapacity": { "member": "int32", "offset": 0x1c },
	},
};
export const Structure = {
	"inherit": RoomObject,
	"struct": {
		"#noAttackNotify": { "member": "bool", "offset": 0x14 },
	},
};
export const Container = {
	"inherit": Structure,
	"variant": "container",
	"struct": {
		"#nextDecayTime": { "member": "int32", "offset": 0x24 },
		"hits": { "member": "int32", "offset": 0x28 },
		"store": { "member": OpenStore, "offset": 0x18 },
	},
};
export const OwnedStructure = {
	"inherit": Structure,
	"struct": {
		"#user": { "member": Id, "offset": 0x18 },
		"#active": {
			"member": { "optional": "bool", "size": 1 },
			"offset": 0x15,
		},
	},
};
export const Controller = {
	"inherit": OwnedStructure,
	"variant": "controller",
	"struct": {
		"#downgradeTime": { "member": "int32", "offset": 0x28 },
		"#progress": { "member": "int32", "offset": 0x2c },
		"#reservationEndTime": { "member": "int32", "offset": 0x30 },
		"#safeModeCooldownTime": { "member": "int32", "offset": 0x34 },
		"#upgradeBlockedUntil": { "member": "int32", "offset": 0x38 },
		"isPowerEnabled": { "member": "bool", "offset": 0x40 },
		"safeModeAvailable": { "member": "int32", "offset": 0x3c },
	},
};
export const Extension = {
	"inherit": OwnedStructure,
	"variant": "extension",
	"struct": {
		"hits": { "member": "int32", "offset": 0x34 },
		"store": { "member": SingleStore, "offset": 0x28 },
	},
};
export const Extractor = {
	"inherit": OwnedStructure,
	"variant": "extractor",
	"struct": {
		"#cooldownTime": { "member": "int32", "offset": 0x28 },
		"hits": { "member": "int32", "offset": 0x2c },
	},
};
export const InvaderCore = {
	"inherit": OwnedStructure,
	"variant": "invaderCore",
	"struct": {
		"#deployTime": { "member": "int32", "offset": 0x28 },
		"hits": { "member": "int32", "offset": 0x2c },
		"level": { "member": "int8", "offset": 0x30 },
	},
};
export const KeeperLair = {
	"inherit": OwnedStructure,
	"variant": "keeperLair",
	"struct": {
		"#nextSpawnTime": { "member": "int32", "offset": 0x28 },
	},
};
export const Lab = {
	"inherit": OwnedStructure,
	"variant": "lab",
	"struct": {
		"#actionLog": { "member": ActionLog, "offset": 0x34 },
		"#cooldownTime": { "member": "int32", "offset": 0x3c },
		"hits": { "member": "int32", "offset": 0x40 },
		"store": {
			"offset": 0x28,
			"member": {
				"struct": {
					"#energy": { "member": "int32", "offset": 0x0 },
					"#mineralAmount": { "member": "int32", "offset": 0x4 },
					"#mineralType": { "member": ResourceType, "offset": 0x8 },
				},
			},
		},
	},
};
export const Link = {
	"inherit": OwnedStructure,
	"variant": "link",
	"struct": {
		"#actionLog": { "member": ActionLog, "offset": 0x34 },
		"#cooldownTime": { "member": "int32", "offset": 0x3c },
		"hits": { "member": "int32", "offset": 0x40 },
		"store": { "member": SingleStore, "offset": 0x28 },
	},
};
export const Nuker = {
	"inherit": OwnedStructure,
	"variant": "nuker",
	"struct": {
		"#cooldownTime": { "member": "int32", "offset": 0x30 },
		"hits": { "member": "int32", "offset": 0x34 },
		"store": {
			"offset": 0x28,
			"member": {
				"struct": {
					"#energy": { "member": "int32", "offset": 0x0 },
					"#ghodium": { "member": "int32", "offset": 0x4 },
				},
			},
		},
	},
};
export const Observer = {
	"inherit": OwnedStructure,
	"variant": "observer",
	"struct": {
		"hits": { "member": "int32", "offset": 0x28 },
	},
};
export const Portal = {
	"inherit": Structure,
	"variant": "portal",
	"struct": {
		"#decayTime": { "member": "int32", "offset": 0x28 },
		"#destRoom": { "member": "string", "offset": 0x18 },
		"#destShard": { "member": "string", "offset": 0x20 },
		"#destX": { "member": "int8", "offset": 0x15 },
		"#destY": { "member": "int8", "offset": 0x16 },
	},
};
export const PowerBank = {
	"inherit": Structure,
	"variant": "powerBank",
	"struct": {
		"#nextDecayTime": { "member": "int32", "offset": 0x18 },
		"hits": { "member": "int32", "offset": 0x1c },
		"store": {
			"offset": 0x20,
			"member": {
				"struct": {
					"#amount": { "member": "int32", "offset": 0x0 },
				},
			},
		},
	},
};
export const PowerSpawn = {
	"inherit": OwnedStructure,
	"variant": "powerSpawn",
	"struct": {
		"hits": { "member": "int32", "offset": 0x30 },
		"store": {
			"offset": 0x28,
			"member": {
				"struct": {
					"#energy": { "member": "int32", "offset": 0x0 },
					"#power": { "member": "int32", "offset": 0x4 },
				},
			},
		},
	},
};
export const Rampart = {
	"inherit": OwnedStructure,
	"variant": "rampart",
	"struct": {
		"#nextDecayTime": { "member": "int32", "offset": 0x28 },
		"hits": { "member": "int32", "offset": 0x2c },
		"isPublic": { "member": "bool", "offset": 0x30 },
	},
};
export const Road = {
	"inherit": Structure,
	"variant": "road",
	"struct": {
		"#nextDecayTime": { "member": "int32", "offset": 0x18 },
		"#terrain": { "member": "int8", "offset": 0x15 },
		"hits": { "member": "int32", "offset": 0x1c },
	},
};
export const Spawn = {
	"inherit": OwnedStructure,
	"variant": "spawn",
	"struct": {
		"hits": { "member": "int32", "offset": 0x3c },
		"name": { "member": "string", "offset": 0x34 },
		"store": { "member": SingleStore, "offset": 0x28 },
		"spawning": {
			"offset": 0x40,
			"member": {
				"align": 4,
				"size": 52,
				"uninitialized": null,
				"pointer": {
					"struct": {
						"#spawnId": { "member": Id, "offset": 0x0 },
						"#spawnTime": { "member": "int32", "offset": 0x2c },
						"#spawningCreepId": { "member": Id, "offset": 0x10 },
						"needTime": { "member": "int32", "offset": 0x30 },
						"directions": {
							"offset": 0x20,
							"member": {
								"optional": { "align": 1, "size": 1, "stride": 1, "vector": "int8" },
								"size": 8,
							},
						},
					},
				},
			},
		},
	},
};
export const Storage = {
	"inherit": OwnedStructure,
	"variant": "storage",
	"struct": {
		"hits": { "member": "int32", "offset": 0x34 },
		"store": { "member": OpenStore, "offset": 0x28 },
	},
};
export const StructureFactory = {
	"inherit": OwnedStructure,
	"variant": "factory",
	"struct": {
		"#actionLog": { "member": ActionLog, "offset": 0x34 },
		"#cooldownTime": { "member": "int32", "offset": 0x3c },
		"#level": { "member": "int32", "offset": 0x40 },
		"hits": { "member": "int32", "offset": 0x44 },
		"store": { "member": OpenStore, "offset": 0x28 },
	},
};
export const StructureTerminal = {
	"inherit": OwnedStructure,
	"variant": "terminal",
	"struct": {
		"#cooldownTime": { "member": "int32", "offset": 0x34 },
		"hits": { "member": "int32", "offset": 0x38 },
		"store": { "member": OpenStore, "offset": 0x28 },
	},
};
export const Tombstone = {
	"inherit": RoomObject,
	"variant": "tombstone",
	"struct": {
		"#decayTime": { "member": "int32", "offset": 0x58 },
		"deathTime": { "member": "int32", "offset": 0x5c },
		"store": { "member": OpenStore, "offset": 0x4c },
		"#creep": {
			"offset": 0x14,
			"member": {
				"struct": {
					"id": { "member": Id, "offset": 0x0 },
					"name": { "member": "string", "offset": 0x28 },
					"ticksToLive": { "member": "int32", "offset": 0x34 },
					"user": { "member": Id, "offset": 0x10 },
					"body": {
						"offset": 0x20,
						"member": {
							"align": 1,
							"size": 1,
							"stride": 1,
							"vector": {
								"enum": [ "move", "work", "carry", "attack", "ranged_attack", "tough", "heal", "claim" ],
							},
						},
					},
					"saying": {
						"offset": 0x30,
						"member": {
							"align": 4,
							"size": 13,
							"pointer": {
								"struct": {
									"isPublic": { "member": "bool", "offset": 0xc },
									"message": { "member": "string", "offset": 0x0 },
									"time": { "member": "int32", "offset": 0x8 },
								},
							},
						},
					},
				},
			},
		},
	},
};
export const Tower = {
	"inherit": OwnedStructure,
	"variant": "tower",
	"struct": {
		"#actionLog": { "member": ActionLog, "offset": 0x34 },
		"hits": { "member": "int32", "offset": 0x3c },
		"store": { "member": SingleStore, "offset": 0x28 },
	},
};
export const Wall = {
	"inherit": Structure,
	"variant": "constructedWall",
	"struct": {
		"hits": { "member": "int32", "offset": 0x18 },
	},
};
export const AnyObject = {
	"variant": [
		{ "align": 4, "layout": Ruin, "size": 84 },
		{ "align": 4, "layout": Container, "size": 44 },
		{ "align": 4, "layout": Resource, "size": 25 },
		{ "align": 4, "layout": Creep, "size": 89 },
		{ "align": 4, "layout": Tombstone, "size": 96 },
		{ "align": 4, "layout": Extractor, "size": 48 },
		{ "align": 4, "layout": Mineral, "size": 33 },
		{ "align": 4, "layout": Lab, "size": 68 },
		{ "align": 4, "layout": Rampart, "size": 49 },
		{ "align": 4, "layout": Tower, "size": 64 },
		{ "align": 4, "layout": Wall, "size": 28 },
		{ "align": 4, "layout": ConstructionSite, "size": 53 },
		{ "align": 4, "layout": StructureFactory, "size": 72 },
		{ "align": 4, "layout": Deposit, "size": 37 },
		{ "align": 4, "layout": InvaderCore, "size": 49 },
		{ "align": 4, "layout": Link, "size": 68 },
		{ "align": 4, "layout": Storage, "size": 56 },
		{ "align": 4, "layout": StructureTerminal, "size": 60 },
		{ "align": 4, "layout": Controller, "size": 65 },
		{ "align": 4, "layout": Nuker, "size": 56 },
		{ "align": 4, "layout": Nuke, "size": 32 },
		{ "align": 4, "layout": Observer, "size": 44 },
		{ "align": 4, "layout": ObserverSpy, "size": 36 },
		{ "align": 4, "layout": Portal, "size": 44 },
		{ "align": 4, "layout": PowerBank, "size": 36 },
		{ "align": 4, "layout": PowerSpawn, "size": 52 },
		{ "align": 4, "layout": Road, "size": 32 },
		{ "align": 4, "layout": Source, "size": 32 },
		{ "align": 4, "layout": KeeperLair, "size": 44 },
		{ "align": 4, "layout": Extension, "size": 56 },
		{ "align": 4, "layout": Spawn, "size": 68 },
	],
};
export default AnyObject;
