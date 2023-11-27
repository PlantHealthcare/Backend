const { MongoClient, ObjectId } = require('mongodb');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const mqtt = require('mqtt');

const uri = "mongodb+srv://admin:admin@planthealthcare.clkuzby.mongodb.net/";
const dbName = "PlantHealthcare";
const userDevicesCollectionName = "userdevices";
const userPlantsCollectionName = "userplants";

const serialPort = new SerialPort({ path: 'COM4', baudRate: 9600 });
const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

const mqttClient = mqtt.connect('mqtt://localhost');

let soil_moisture = 0;
let humidity = 0;
let temperature = 0;
let lastPlantId = null; 
let connectedSensors = {}; 

parser.on('data', async (data) => {
    const values = data.trim().split(' ');

    if (values.length >= 9) {
        soil_moisture = parseInt(values[2]) || 0;
        humidity = parseInt(values[5]) || 0;
        temperature = parseInt(values[8]) || 0;

        console.log(`Talajnedvesség: ${soil_moisture}%`);
        console.log(`Páratartalom: ${humidity}%`);
        console.log(`Hőmérséklet: ${temperature}°C`);
    }
});

mqttClient.on('connect', function () {
    console.log("MQTT kapcsolat sikeresen létrejött.");
    mqttClient.subscribe('careNeeded', function (err) {
        if (!err) {
            console.log("Feliratkozás a 'careNeeded' témára megtörtént.");
        } else {
            console.error("Hiba történt a feliratkozás során:", err);
        }
    });
    monitorCollection();
});

async function monitorCollection() {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        console.log("Sikeres kapcsolat az adatbázissal.");
        const db = client.db(dbName);
        const collection = db.collection(userPlantsCollectionName);
        const changeStream = collection.watch();

        console.log("Változásfigyelő beállítva a gyűjteményben:", userPlantsCollectionName);
        changeStream.on('change', (change) => {
            console.log("Észlelt változás:", change);
            if (change.updateDescription && change.updateDescription.updatedFields.careNeeded !== undefined) {
                const careNeeded = change.updateDescription.updatedFields.careNeeded;
                console.log("Az careNeeded változott:", careNeeded);
                const message = careNeeded ? '1' : '0';
                console.log("Az üzenet tartalma:", message);
                mqttClient.publish('careNeeded', message);
            }
        });
    } catch (err) {
        console.error("Hiba történt az adatbázis műveletek során:", err);
    }
}

mqttClient.on('message', (topic, message) => {
    if (topic === 'careNeeded') {
        console.log(`Soros portra küldött üzenet: ${message.toString()}`);
        serialPort.write(message.toString(), function(err) {
            if (err) {
                console.log('Hiba a soros porton küldött adatban:', err.message);
            } else {
                console.log('Parancs sikeresen elküldve a soros porton');
            }
        });
    }
});

mqttClient.on('error', function (error) {
    console.error("MQTT hiba:", error);
});

async function monitorPlantIdChanges() {
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const database = client.db(dbName);
        const collection = database.collection(userDevicesCollectionName);

        const changeStream = collection.watch([
            { $match: { 'operationType': 'update' } }
        ]);

        changeStream.on('change', async (next) => {
            if (next.operationType === 'update') {
                const updatedFields = next.updateDescription.updatedFields;
                if ('plant_id' in updatedFields) {
                    lastPlantId = updatedFields.plant_id;
                    console.log(`Új plant_id: ${lastPlantId}`);

                    const sensors = await collection.find({ plant_id: lastPlantId }).toArray();
                    connectedSensors[lastPlantId] = new Set(sensors.map(s => s.name));
                }
            }
        });

    } catch (e) {
        console.error(e);
    } finally {
        // await client.close(); 
    }
}

async function updateSensorData(newPlantId, temperature, humidity, soil_moisture) {
    const client = new MongoClient(uri);

    try {
        await client.connect();

        const database = client.db(dbName);
        const collection = database.collection(userPlantsCollectionName);

        const plant = await collection.findOne({ _id: new ObjectId(newPlantId) });

        if (plant) {
            const updatedPlant = {
                temperature: temperature,
                humidity: humidity,
                soil_moisture: soil_moisture
            };

            const result = await collection.updateOne(
                { _id: new ObjectId(newPlantId) },
                { $set: updatedPlant }
            );

            if (result.modifiedCount > 0) {
                console.log(`Sensor data updated for plant with ID ${newPlantId}`);
            } else {
                console.log(`No changes made for plant with ID ${newPlantId}`);
            }
        } else {
            console.log(`Plant with ID ${newPlantId} not found`);
        }
    } catch (error) {
        console.error("Error updating sensor data:", error);
    } finally {
        await client.close();
    }
}

async function periodicallyUpdateSensorData() {
    setInterval(async () => {
        if (lastPlantId && connectedSensors[lastPlantId]) {
            const sensors = connectedSensors[lastPlantId];
            if (sensors.has('temperature') && sensors.has('humidity') && sensors.has('soil_moisture')) {
                await updateSensorData(lastPlantId, temperature, humidity, soil_moisture);
            } else if (sensors.has('temperature') && sensors.has('humidity')) {
                await updateSensorData(lastPlantId, temperature, humidity, 0);
            } else if (sensors.has('temperature') && sensors.has('soil_moisture')) {
                await updateSensorData(lastPlantId, temperature, 0, soil_moisture);
            } else if (sensors.has('humidity') && sensors.has('soil_moisture')) {
                await updateSensorData(lastPlantId, 0, humidity, soil_moisture);
            } else if (sensors.has('temperature')) {
                await updateSensorData(lastPlantId, temperature, 0, 0);
            } else if (sensors.has('humidity')) {
                await updateSensorData(lastPlantId, 0, humidity, 0);
            } else if (sensors.has('soil_moisture')) {
                await updateSensorData(lastPlantId, 0, 0, soil_moisture);
            }
        }
    }, 10000);
}

monitorPlantIdChanges();
periodicallyUpdateSensorData();
