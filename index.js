var express = require("express");
var app = express();
var http = require("http").Server(app);
var io = require("socket.io")(http, {
  cors: {
    origin: "*",
    transports: ["websocket"],
  },
});

var mysql = require("mysql");
var moment = require("moment");
var sockets = {};

var con = mysql.createConnection({
  host: "db2",
  user: "root",
  password: "my-secret-pw",
  database: "kopikayumaschat",
});

con.connect(function (err) {
  if (err) throw err;
  console.log("Database Connected");
});

const amqp = require("amqplib/callback_api");

const rabbitmqUrl = "amqp://rabbitmq:5672"; // Replace this with your RabbitMQ URL if it's not running on localhost

let channel;
let queueName;

function connectToRabbitMQ() {
  amqp.connect(rabbitmqUrl, (error, connection) => {
    if (error) {
      setTimeout(connectToRabbitMQ, 5000); // 5000 milliseconds (5 seconds)
      return;
    }

    connection.createChannel((error, ch) => {
      if (error) {
        throw error;
      }
      channel = ch;
      channel.assertExchange("chatExchange", "direct", { durable: false });

      channel.assertQueue("", { exclusive: true }, (error, q) => {
        if (error) {
          throw error;
        }
        queueName = q.queue;
        channel.bindQueue(q.queue, "chatExchange", "messageSent");
        channel.consume(
          q.queue,
          (msg) => {
            const data = JSON.parse(msg.content.toString());
            console.log("Message consumed:", data);
            if (sockets.hasOwnProperty(data.other_user_id)) {
              for (var index in sockets[data.other_user_id]) {
                sockets[data.other_user_id][index].emit(
                  "receive_message",
                  data
                );
              }
            }
          },
          { noAck: true }
        );
      });
    });
  });
}

// Connect to RabbitMQ with an initial delay
setTimeout(connectToRabbitMQ, 5000);

io.on("connection", function (socket) {
  if (!sockets[socket.handshake.query.user_id]) {
    sockets[socket.handshake.query.user_id] = [];
  }
  sockets[socket.handshake.query.user_id].push(socket);
  socket.broadcast.emit("user_connected", socket.handshake.query.user_id);

  // con.query(
  //   `UPDATE kopikayumas.users SET is_online=1 where id=${socket.handshake.query.user_id}`,
  //   function (err, res) {
  //     if (err) throw err;
  //     console.log("User Connected", socket.handshake.query.user_id);
  //   }
  // );

  socket.on("disconnect_button", function () {
    con.query("DELETE FROM chats", function (err, res) {
      if (err) throw err;
      console.log("Database cache deleted");
      socket.emit("table_cleared");
    });
  });

  socket.on("send_message", function (data) {
    var group_id =
      data.user_id > data.other_user_id
        ? data.user_id + data.other_user_id
        : data.other_user_id + data.user_id;
    var time = moment().format("h:mm A");
    var created_at = moment().format("YYYY-MM-DD HH:mm:ss"); // Add this line to get the current timestamp
    data.time = time;
    con.query(
      `INSERT INTO chats (user_id, other_user_id, message, group_id,  created_at) values (${data.user_id},${data.other_user_id}, '${data.encrypted_message}',${group_id}, '${created_at}')`,
      function (err, res) {
        if (err) throw err;
        data.id = res.insertId;

        // Emit the message directly to the sender
        for (var index in sockets[data.user_id]) {
          sockets[data.user_id][index].emit("receive_message", data);
        }

6

        console.log("Message sent to recipient:", data);
      }
    );
  });

  socket.on("read_message", function (id) {
    con.query(`UPDATE chats set is_read=1 where id=${id}`, function (err, res) {
      if (err) throw err;
      console.log("Message read");
    });
  });

  socket.on("disconnect", function (err) {
    socket.broadcast.emit("user_disconnected", socket.handshake.query.user_id);
    for (var index in sockets[socket.handshake.query.user_id]) {
      if (socket.id == sockets[socket.handshake.query.user_id][index].id) {
        sockets[socket.handshake.query.user_id].splice(index, 1);
      }
    }
    // con.query(
    //   `UPDATE kopikayumas.users SET is_online=0 where id=${socket.handshake.query.user_id}`,
    //   function (err, res) {
    //     if (err) throw err;
    //     console.log("User Disconnected", socket.handshake.query.user_id);
    //   }
    // );
  });
});

const cron = require("node-cron");

// Schedule a cron job to run every 10 minutes
cron.schedule("*/10 * * * *", () => {
  console.log("Cron job started to delete old messages");

  // Find the group_ids where messages are older than 10 minutes
  con.query(
    "SELECT DISTINCT group_id FROM chats WHERE TIMESTAMPDIFF(MINUTE, created_at, NOW()) >= 10",
    (err, rows) => {
      if (err) throw err;

      // Delete messages with the same group_id
      rows.forEach((row) => {
        con.query(
          `DELETE FROM chats WHERE group_id=${row.group_id}`,
          (err, res) => {
            if (err) throw err;
            console.log(
              "Deleted old messages for group_id:",
              row.group_id,
              "affected rows:",
              res.affectedRows
            );
          }
        );
      });
    }
  );
});

http.listen(3000);
