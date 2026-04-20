const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

app.post("/order", async (req, res) => {
  try {
    const order = req.body;

    console.log("Order received:", order.id);

    const payload = {
      orderReference: order.id,
      name: order.shipping_address?.name,
      address1: order.shipping_address?.address1,
      city: order.shipping_address?.city,
      postcode: order.shipping_address?.zip,
      country: order.shipping_address?.country,
      items: order.line_items.map(i => ({
        name: i.title,
        quantity: i.quantity,
        weight: (i.grams || 0) / 1000
      }))
    };

    const response = await axios.post(
      "https://api.ezishipping.com/consignment/create",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer YOUR_API_KEY"
        }
      }
    );

    const tracking =
      response.data.trackingNumber ||
      response.data.tracking_number;

    res.json({ success: true, tracking });

  } catch (err) {
    console.log(err.message);
    res.status(500).send("Error");
  }
});

app.listen(3000, () => {
  console.log("Server running");
});
