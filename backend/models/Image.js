const mongoose = require("mongoose");

const ImageSchema = new mongoose.Schema({
    url: {
        type: String,
        required: true
    },
    fileId: {
        type: String
    },
    fileName: {
        type: String
    },
    filter: {
        type: String
    },
    meta: {
        type: Object
    },
}, {
    timestamps: true
});

module.exports = mongoose.model("Image", ImageSchema);